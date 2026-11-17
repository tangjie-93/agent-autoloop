<script setup lang="ts">
import type { ConnectionProps, ConnectionEmits } from "../types/console";
defineProps<ConnectionProps>();
const emit = defineEmits<ConnectionEmits>();
// Autofill may update the DOM without emitting input; keep the manual deployment's visible value authoritative.
function connect(event: SubmitEvent) {
  const form = event.currentTarget as HTMLFormElement;
  const key = String(new FormData(form).get("owner") ?? "").trim();
  if (!key) return;
  emit("connect", key);
  form.reset();
}
</script>
<template>
  <section class="connection">
    <div>
      <h2>连接你的中台</h2>
      <p v-if="mode === 'local'">本机安全连接，无需填写密钥。断开只关闭操作台连接，不停止后台任务。</p>
      <p v-else-if="mode === 'manual'">独立部署需使用本人密钥；密钥只保存在本页内存中。</p>
      <p v-else>正在检查本机连接方式。</p>
    </div>
    <button
      v-if="mode === 'local'"
      :class="{ primary: !connected }"
      :aria-busy="connecting"
      @click="connected || connecting ? emit('disconnect') : emit('connect')"
    >
      {{ connecting ? "连接中…（点击取消）" : connected ? "断开连接" : "连接中台" }}
    </button>
    <button v-else-if="mode === 'checking'" disabled>检查连接中…</button>
    <button v-else-if="mode === 'error'" @click="emit('retry')">重新检查连接</button>
    <form v-else @submit.prevent="connect">
      <label for="owner-key">本人密钥</label>
      <div class="input-row">
        <input
          id="owner-key"
          name="owner"
          type="password"
          autocomplete="off"
          placeholder="输入本人密钥"
          required
          :disabled="busy || connecting"
        />
        <button class="primary" :disabled="busy || connecting">{{ connecting ? "连接中…" : "连接中台" }}</button>
        <button v-if="connected || connecting" type="button" @click="emit('disconnect')">断开连接</button>
      </div>
    </form>
  </section>
</template>
<style scoped>
.connection > button {
  justify-self: end;
  min-width: 108px;
}
</style>
