"""ChatModel 工厂。

统一管理 LLM 配置读取与 LangChain ChatModel 构建，避免业务层重复拼装参数。
"""

import os
from typing import Optional

from langchain_anthropic import ChatAnthropic
from langchain_google_genai import ChatGoogleGenerativeAI, HarmBlockThreshold, HarmCategory
from langchain_openai import ChatOpenAI
from langchain_qwq import ChatQwen
from sqlmodel import Session

from app.db.models import LLMConfig
from app.services import llm_config_service

# NovelForge 是小说创作工具，续写/润色内容常涉及暴力、感情纠葛等成人向题材。
# Gemini 默认的安全阈值对这类正常创作内容也会拦截（表现为空输出/
# finish_reason=SAFETY），这里放宽到 BLOCK_NONE，交由用户自行把关内容。
_GOOGLE_SAFETY_SETTINGS = {
    HarmCategory.HARM_CATEGORY_HARASSMENT: HarmBlockThreshold.BLOCK_NONE,
    HarmCategory.HARM_CATEGORY_HATE_SPEECH: HarmBlockThreshold.BLOCK_NONE,
    HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT: HarmBlockThreshold.BLOCK_NONE,
    HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT: HarmBlockThreshold.BLOCK_NONE,
}


def _sanitize_common_generation_kwargs(
    *,
    temperature: Optional[float],
    max_tokens: Optional[int],
    timeout: Optional[float],
) -> dict:
    normalized_max_tokens = None if max_tokens == -1 else max_tokens
    kwargs: dict = {}
    if temperature is not None:
        kwargs["temperature"] = float(temperature)
    if normalized_max_tokens is not None:
        kwargs["max_tokens"] = int(normalized_max_tokens)
    if timeout is not None:
        kwargs["timeout"] = float(timeout)
    return kwargs


def _build_openai_family_transport_kwargs(transport: dict) -> dict:
    kwargs: dict = {}
    if transport["request_base"]:
        # LangChain 这里统一接收 `base_url`。
        # 之前传成 `openai_api_base` 会导致 `ChatQwen` 忽略自定义网关，
        # 旧的 openai_compatible 配置就会错误落回默认供应商端点。
        kwargs["base_url"] = transport["request_base"]
    if transport["default_headers"]:
        kwargs["default_headers"] = transport["default_headers"]
    if transport["api_protocol"] != "auto":
        kwargs["use_responses_api"] = transport["api_protocol"] == "responses"
    elif transport["use_responses_api"]:
        kwargs["use_responses_api"] = True
    return kwargs


def build_chat_model_from_payload(
    *,
    provider: str,
    model_name: str,
    api_key: str | None,
    api_base: str | None = None,
    base_url: str | None = None,
    api_protocol: str | None = None,
    custom_request_path: str | None = None,
    user_agent: str | None = None,
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
    timeout: Optional[float] = None,
    thinking_enabled: Optional[bool] = None,
):
    # Google 允许留空 API Key，改走 ADC（Vertex AI，见下方 google 分支）；
    # 其他供应商没有等价的免密鉴权方式，仍要求必须提供。
    if not api_key and provider != "google":
        raise ValueError("未提供 API Key")

    transport = llm_config_service.resolve_transport_settings(
        provider=provider,
        api_base=api_base,
        base_url=base_url,
        api_protocol=api_protocol,
        custom_request_path=custom_request_path,
        user_agent=user_agent,
    )
    provider_name = transport["provider"]
    common_kwargs = _sanitize_common_generation_kwargs(
        temperature=temperature,
        max_tokens=max_tokens,
        timeout=timeout,
    )

    if provider_name in {"openai_compatible", "openai"}:
        model_kwargs = {
            "model": model_name,
            "api_key": api_key,
            **_build_openai_family_transport_kwargs(transport),
            **common_kwargs,
        }
        if thinking_enabled is not None:
            model_kwargs["extra_body"] = {"enable_thinking": thinking_enabled}

        # `responses` 模式下统一走 `ChatOpenAI`。
        # 原先 openai_compatible 仍走 `ChatQwen`，会在流式 continuation 时构造出
        # 不满足 openai-python Responses API 要求的 payload，触发
        # “Missing required arguments; Expected either ('messages' and 'model') ...”。
        if transport["use_responses_api"]:
            return ChatOpenAI(**model_kwargs)

        if provider_name == "openai_compatible":
            return ChatQwen(**model_kwargs)
        return ChatOpenAI(**model_kwargs)

    if provider_name == "anthropic":
        model_kwargs = {
            "model": model_name,
            "api_key": api_key,
            **common_kwargs,
        }
        if thinking_enabled is True:
            model_kwargs["thinking"] = {"type": "enabled", "budget_tokens": 2048}
        return ChatAnthropic(**model_kwargs)

    if provider_name == "google":
        model_kwargs = {"model": model_name, "safety_settings": _GOOGLE_SAFETY_SETTINGS}
        if api_key:
            model_kwargs["api_key"] = api_key
        else:
            # 无 API Key：走 Vertex AI + ADC（google.auth.default()）。
            # `location` 字段本身会读取 GOOGLE_CLOUD_LOCATION，但 `project` 不会，
            # 这里显式传入，避免依赖底层 SDK 的隐性 env 回退（见 backend/.env）。
            model_kwargs["vertexai"] = True
            google_cloud_project = os.environ.get("GOOGLE_CLOUD_PROJECT")
            if google_cloud_project:
                model_kwargs["project"] = google_cloud_project
        if thinking_enabled is not None:
            model_kwargs["include_thoughts"] = thinking_enabled
        thinking_budget = None
        if thinking_enabled is not True:
            # Gemini 2.5 系列默认开启“动态思考”：模型会先做一段不可见的推理，
            # 期间不产出任何 token，思考完才把最终文本几乎一次性倒出，
            # 观感上等同于“没有流式输出”。小说续写/润色等创作任务不需要
            # 长链推理，这里尽量关闭思考——2.5 Pro 系列不允许完全关闭
            # （预算下限 128），其余系列可直接设为 0。
            thinking_budget = 128 if "pro" in model_name.lower() else 0
            model_kwargs["thinking_budget"] = thinking_budget
        if common_kwargs.get("max_tokens") is not None:
            max_output_tokens = common_kwargs["max_tokens"]
            if thinking_budget:
                # 思考 token 会从 max_output_tokens 里扣（Gemini 已知行为，
                # 见 googleapis/python-genai#782）。续写这类调用的 max_tokens
                # 常常按目标字数算得很小，不预留的话会被思考耗尽整个预算，
                # 导致正文 0 字、finish_reason=MAX_TOKENS。
                max_output_tokens += thinking_budget
            model_kwargs["max_output_tokens"] = max_output_tokens
        if common_kwargs.get("temperature") is not None:
            model_kwargs["temperature"] = common_kwargs["temperature"]
        if common_kwargs.get("timeout") is not None:
            model_kwargs["timeout"] = common_kwargs["timeout"]
        return ChatGoogleGenerativeAI(**model_kwargs)

    raise ValueError(f"不支持的 LLM 提供商: {provider}")


def _get_llm_config(session: Session, llm_config_id: int) -> LLMConfig:
    cfg = llm_config_service.get_llm_config(session, llm_config_id)
    if not cfg:
        raise ValueError(f"LLM 配置不存在，ID: {llm_config_id}")
    # google 允许留空 API Key（走 ADC/Vertex AI，见 build_chat_model_from_payload）
    if not cfg.api_key and cfg.provider != "google":
        raise ValueError(f"未找到 LLM 配置 {cfg.display_name or cfg.model_name} 的 API 密钥")
    return cfg


def build_chat_model(
    session: Session,
    llm_config_id: int,
    *,
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
    timeout: Optional[float] = None,
    thinking_enabled: Optional[bool] = None,
):
    cfg = _get_llm_config(session, llm_config_id)
    return build_chat_model_from_payload(
        provider=cfg.provider,
        model_name=cfg.model_name,
        api_key=cfg.api_key,
        api_base=cfg.api_base,
        base_url=cfg.base_url,
        api_protocol=getattr(cfg, "api_protocol", None),
        custom_request_path=getattr(cfg, "custom_request_path", None),
        user_agent=getattr(cfg, "user_agent", None),
        temperature=temperature,
        max_tokens=max_tokens,
        timeout=timeout,
        thinking_enabled=thinking_enabled,
    )
