from typing import Literal


SeedSyncResult = Literal["builtin", "migrated", "conflict"]


def _set_if_changed(record: object, field_name: str, value: object) -> bool:
    if getattr(record, field_name) == value:
        return False
    setattr(record, field_name, value)
    return True


def sync_builtin_seed(
    record: object,
    *,
    content_field: str,
    original_content_field: str,
    seed_content: str,
    seed_description: str | None,
    overwrite: bool,
) -> tuple[SeedSyncResult, bool]:
    """同步单个种子，避免接管内容不同的同名自定义记录。"""
    description = getattr(record, "description")
    content = getattr(record, content_field)
    is_builtin = bool(getattr(record, "built_in", False))
    is_modified = bool(getattr(record, "is_modified", False))

    if not is_builtin and (content != seed_content or description != seed_description):
        return "conflict", False

    changed = False
    changed |= _set_if_changed(record, "original_description", seed_description)
    changed |= _set_if_changed(record, original_content_field, seed_content)
    changed |= _set_if_changed(record, "built_in", True)

    # 用户已在 UI 里手动修改过的内置项不再被自动覆盖，否则每次后端重启
    # （overwrite 默认开启，用于同步内置种子的上游更新）都会把用户的
    # 自定义内容重置回种子文件，is_modified 标记也就形同虚设。
    # 用户仍可通过“重置”按钮主动恢复为种子内容。
    if (overwrite and not is_modified) or not is_builtin:
        changed |= _set_if_changed(record, content_field, seed_content)
        changed |= _set_if_changed(record, "description", seed_description)
        changed |= _set_if_changed(record, "is_modified", False)

    return ("migrated" if not is_builtin else "builtin"), changed
