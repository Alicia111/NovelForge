<template>
  <el-dialog
    :model-value="visible"
    :title="title || '续写配置'"
    width="560px"
    @close="handleCancel"
  >
    <div class="dialog-body">
      <el-form label-position="top" size="small">
        <el-form-item label="续写指导要求">
          <el-input
            v-model="localGuidance"
            type="textarea"
            :rows="4"
            placeholder="例如：节奏再慢一点，强化心理活动，结尾埋一个悬念。"
          />
        </el-form-item>
        <el-form-item label="字数预算口径">
          <el-radio-group v-model="localBudgetScope">
            <el-radio-button label="per_run">本次输出上限</el-radio-button>
            <el-radio-button label="total">全章目标总字数</el-radio-button>
          </el-radio-group>
          <div class="mode-help">
            <p v-if="localBudgetScope === 'per_run'">每次续写最多写这么多字，正文越写越长也不会失效。</p>
            <p v-else>整章写到这个字数为止；正文已超过该数值时本次续写不会再产出内容。</p>
          </div>
        </el-form-item>
        <el-form-item :label="localBudgetScope === 'per_run' ? '本次输出上限' : '目标总字数'">
          <el-input-number
            v-model="localTargetWordCount"
            :min="200"
            :max="200000"
            :step="100"
            :controls-position="'right'"
          />
          <span class="helper-text">{{ localBudgetScope === 'per_run' ? '本次续写新增的字数' : '全章累计字数' }}</span>
        </el-form-item>
        <el-form-item label="字数控制模式">
          <el-radio-group v-model="localWordControlMode">
            <el-radio-button label="prompt_only">提示词约束</el-radio-button>
            <el-radio-button label="balanced">控制模式</el-radio-button>
          </el-radio-group>
          <div class="mode-help">
            <p v-if="localWordControlMode === 'prompt_only'">只做提示词约束，不做运行时硬收束，文本最自然，但字数偏差会更大。</p>
            <p v-else>会按目标字数切分为多个轮次并分配预算，非最终轮带硬上限，结尾轮不强截断。</p>
            <p v-if="localWordControlMode === 'balanced'">该模式下创作可能会消耗更多 token；如果对字数要求没那么严格，可以使用提示词约束模式。</p>
          </div>
        </el-form-item>
      </el-form>
    </div>
    <template #footer>
      <div class="dialog-footer">
        <el-button @click="handleCancel">取消</el-button>
        <el-button type="primary" @click="handleConfirm">{{ confirmText || '开始续写' }}</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

export type ContinuationWordControlMode = 'prompt_only' | 'balanced'
/** per_run：本次续写最多写多少字；total：整章写到多少字为止 */
export type ContinuationWordBudgetScope = 'per_run' | 'total'

const props = defineProps<{
  visible: boolean
  targetWordCount: number
  wordControlMode: ContinuationWordControlMode
  budgetScope: ContinuationWordBudgetScope
  guidance: string
  /** 对话框标题，重生成场景可覆盖 */
  title?: string
  /** 确认按钮文案，重生成场景可覆盖 */
  confirmText?: string
}>()

type ContinuationConfigPayload = {
  targetWordCount: number
  wordControlMode: ContinuationWordControlMode
  budgetScope: ContinuationWordBudgetScope
  guidance: string
}

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'confirm', payload: ContinuationConfigPayload): void
  /** 关闭而没确认：把当前输入回传给父级存成草稿，下次打开不用重打 */
  (e: 'cancel', payload: ContinuationConfigPayload): void
}>()

function collectPayload(): ContinuationConfigPayload {
  return {
    targetWordCount: Math.max(200, Math.floor(localTargetWordCount.value || 3000)),
    wordControlMode: localWordControlMode.value,
    budgetScope: localBudgetScope.value,
    guidance: localGuidance.value.trim(),
  }
}

const localTargetWordCount = ref<number>(3000)
const localWordControlMode = ref<ContinuationWordControlMode>('balanced')
const localBudgetScope = ref<ContinuationWordBudgetScope>('per_run')
const localGuidance = ref<string>('')

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return
    localTargetWordCount.value = props.targetWordCount || 3000
    localWordControlMode.value = props.wordControlMode || 'balanced'
    localBudgetScope.value = props.budgetScope || 'per_run'
    localGuidance.value = props.guidance || ''
  },
  { immediate: true }
)

function handleCancel() {
  if (props.visible) emit('cancel', collectPayload())
  emit('update:visible', false)
}

function handleConfirm() {
  emit('confirm', collectPayload())
  emit('update:visible', false)
}
</script>

<style scoped>
.dialog-body {
  padding: 4px 0;
}

.helper-text {
  margin-left: 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.mode-help {
  margin-top: 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.6;
}

.mode-help p {
  margin: 0;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
