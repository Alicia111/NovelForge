import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { readFileSync } from 'fs'
import { loadBackendPort } from './scripts/backend-config.mjs'

// 读取 package.json 中的版本号
const packageJson = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))
const version = packageJson.version
const backendPort = loadBackendPort({ envFiles: [resolve(__dirname, '../backend/.env')] })
const backendOrigin = `http://127.0.0.1:${backendPort}`

export default defineConfig({
  root: 'src/renderer',
  base: './',
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(version),
    'import.meta.env.VITE_BACKEND_PORT': JSON.stringify(String(backendPort))
  },
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@': resolve(__dirname, 'src/renderer/src')
    }
  },
  plugins: [
    vue(),
    {
      name: 'html-transform',
      transformIndexHtml(html) {
        // 更新 CSP：
        // - 允许连接 GitHub API
        // - 放宽 connect-src，支持访问任意后端主机（方便局域网 / 服务器部署）
        return html.replace(
          /<meta\s+http-equiv=["']Content-Security-Policy["'].*?>/i,
          '<meta http-equiv="Content-Security-Policy" content="' +
          "default-src 'self'; " +
          "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; " +
          "style-src 'self' 'unsafe-inline'; " +
          // 这里使用 connect-src *，方便本地和局域网部署；如果将来需要更严格策略可再收紧
          "connect-src * https://api.github.com;" +
          '">'
        )
      }
    }
  ],
  server: {
    host: true, // 监听所有网卡，方便通过局域网 / Tailscale 内网 IP 访问
    // Vite 5+ 默认只接受识别的 Host 请求头；局域网 / Tailscale MagicDNS 主机名
    // （如 nekolia、nekolia.tail117e62.ts.net）访问时会被拒绝，这里放开检查
    allowedHosts: true,
    // 5173 已被本机其他容器（ai-novel-frontend）长期占用，
    // 不锁端口时 vite 会静默退到 5174，导致开发中的改动看起来「没生效」
    port: 5273,
    strictPort: true,
    proxy: {
      '/api': {
        target: backendOrigin,
        changeOrigin: true,
      },
      '/imgs': {
        target: backendOrigin,
        changeOrigin: true,
      }
    }
  },
  // 手机 / 平板走打包后的产物，避免 dev server 上千个模块请求逐个吃 RTT。
  // preview 不会继承 server 的这些设置，需要显式再写一遍。
  preview: {
    host: true,
    allowedHosts: true,
    // 与 dev 的 5273 对齐命名；strictPort 让端口冲突直接报错而不是静默漂移
    port: 4273,
    strictPort: true
  },
  build: {
    outDir: '../../dist-web',
    emptyOutDir: true
  }
})
