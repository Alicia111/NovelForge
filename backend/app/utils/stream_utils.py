"""流式响应工具函数"""

import json
from typing import AsyncGenerator


async def wrap_sse_stream(generator: AsyncGenerator[str, None]) -> AsyncGenerator[str, None]:
    """将纯文本流包装为 SSE (Server-Sent Events) 格式
    
    Args:
        generator: 异步文本生成器
        
    Yields:
        SSE 格式的数据流

    异常处理：response 已在流式返回前提交 200 状态码，若生成器中途抛出异常
    直接向外传播会导致连接被无声中断（前端只会看到网络错误）。这里改为捕获
    异常并以显式的 error 事件发出，前端据此弹出可读的错误提示。
    """
    try:
        async for item in generator:
            yield f"data: {json.dumps({'content': item}, ensure_ascii=False)}\n\n"
    except Exception as e:
        yield f"data: {json.dumps({'error': str(e)}, ensure_ascii=False)}\n\n"
