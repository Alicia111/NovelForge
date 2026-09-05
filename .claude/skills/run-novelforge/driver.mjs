// REPL driver for NovelForge's web GUI (Vue 3 app served by Vite).
// Uses playwright-core against the system Chromium (no chromium-cli in this
// environment, no bundled Playwright browser download needed).
// Designed for agents: wrap in tmux, send-keys commands, capture-pane output.
import { chromium } from 'playwright-core'
import * as readline from 'node:readline'
import * as fs from 'node:fs'
import * as path from 'node:path'

const SHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/shots'
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium'
const DEFAULT_URL = process.env.FRONTEND_URL || 'http://127.0.0.1:5173'
fs.mkdirSync(SHOT_DIR, { recursive: true })

let browser = null
let page = null
const consoleLog = []

const COMMANDS = {
  async launch(url) {
    if (browser) return console.log('already launched')
    browser = await chromium.launch({ executablePath: CHROMIUM_PATH, args: ['--no-sandbox'] })
    page = await browser.newPage()
    page.on('console', (m) => consoleLog.push({ type: m.type(), text: m.text() }))
    page.on('pageerror', (e) => consoleLog.push({ type: 'pageerror', text: e.message }))
    const target = url || DEFAULT_URL
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    console.log('launched, at', page.url())
  },

  async nav(url) {
    if (!page) return console.log('ERROR: launch first')
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    console.log('nav ->', page.url())
  },

  async ss(name) {
    if (!page) return console.log('ERROR: launch first')
    const f = path.join(SHOT_DIR, (name || `ss-${Date.now()}`) + '.png')
    await page.screenshot({ path: f })
    console.log('screenshot:', f)
  },

  // DOM click, not locator.click() with coordinates - simpler and immune to
  // overlay/z-index issues, matches the app's own querySelector semantics.
  async click(sel) {
    if (!page) return console.log('ERROR: launch first')
    const r = await page.evaluate((s) => {
      const el = document.querySelector(s)
      if (!el) return 'NOT_FOUND'
      el.click()
      return 'OK'
    }, sel)
    console.log('click', sel, '->', r)
  },

  async 'click-text'(text) {
    if (!page) return console.log('ERROR: launch first')
    const r = await page.evaluate((t) => {
      const els = [...document.querySelectorAll('button, a, [role="button"]')]
      const el = els.find((e) => e.textContent?.trim() === t) ?? els.find((e) => e.textContent?.includes(t))
      if (!el) return 'NOT_FOUND'
      el.click()
      return 'OK: ' + el.tagName
    }, text)
    console.log('click-text', JSON.stringify(text), '->', r)
  },

  // Element Plus / Vue inputs are controlled components - fill() + input
  // event is what makes Vue's v-model pick up the value.
  async fill(args) {
    if (!page) return console.log('ERROR: launch first')
    const sp = args.indexOf(' ')
    const sel = sp === -1 ? args : args.slice(0, sp)
    const text = sp === -1 ? '' : args.slice(sp + 1)
    await page.fill(sel, text)
    console.log('fill', sel, '->', JSON.stringify(text))
  },

  async type(text) {
    if (page) await page.keyboard.type(text, { delay: 20 })
  },
  async press(key) {
    if (page) await page.keyboard.press(key)
  },

  async wait(sel) {
    if (!page) return console.log('ERROR: launch first')
    try {
      await page.waitForSelector(sel, { timeout: 10_000 })
      console.log('found:', sel)
    } catch {
      console.log('TIMEOUT:', sel)
    }
  },

  async eval(expr) {
    if (!page) return console.log('ERROR: launch first')
    try {
      console.log(JSON.stringify(await page.evaluate(expr)))
    } catch (e) {
      console.log('ERROR:', e.message)
    }
  },

  async text(sel) {
    if (!page) return console.log('ERROR: launch first')
    console.log(await page.evaluate((s) => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)', sel || null))
  },

  console(filter) {
    const rows = filter === 'errors' ? consoleLog.filter((c) => c.type === 'error' || c.type === 'pageerror') : consoleLog
    if (!rows.length) return console.log('(no console output captured)')
    for (const r of rows) console.log(`[${r.type}]`, r.text)
  },

  async quit() {
    if (browser) await browser.close().catch(() => {})
    browser = null
    page = null
  },
  help() {
    console.log('commands:', Object.keys(COMMANDS).join(', '))
  },
}

// stdin over the raw fd - not strictly required here (no app steals stdin
// like Electron does) but keeps the driver consistent with the Electron
// version of this pattern.
const stdin = fs.createReadStream(null, { fd: fs.openSync('/dev/stdin', 'r') })
const rl = readline.createInterface({ input: stdin, output: process.stdout, prompt: 'driver> ' })

rl.on('line', async (line) => {
  const trimmed = line.trim()
  const sp = trimmed.indexOf(' ')
  const cmd = sp === -1 ? trimmed : trimmed.slice(0, sp)
  const rest = sp === -1 ? '' : trimmed.slice(sp + 1)
  if (!cmd) return rl.prompt()
  const fn = COMMANDS[cmd]
  if (!fn) {
    console.log('unknown:', cmd, '- try: help')
    return rl.prompt()
  }
  try {
    await fn(rest)
  } catch (e) {
    console.log('ERROR:', e.message)
  }
  if (cmd === 'quit') {
    rl.close()
    process.exit(0)
  }
  rl.prompt()
})
rl.on('close', async () => {
  await COMMANDS.quit()
  process.exit(0)
})

console.log('novelforge driver - "help" for commands, "launch" to start (defaults to', DEFAULT_URL, ')')
rl.prompt()
