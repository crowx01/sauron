import { render, useKeyboard, useTerminalDimensions } from '@opentui/solid';
import { createSignal, createEffect, onCleanup, For, Show } from 'solid-js';
import { chatRouter } from '../router';
import { sessionStore } from '../session';
import { themeStore } from './themes';
import { OpenCodeEngine } from './opencode_engine';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function OpenTUIApp() {
  const dimensions = useTerminalDimensions();
  const [prompt, setPrompt] = createSignal('');
  const [cursorPos, setCursorPos] = createSignal(0);
  const [scrollOffset, setScrollOffset] = createSignal(0);
  const [promptQueue, setPromptQueue] = createSignal<string[]>([]);
  const [isBusy, setIsBusy] = createSignal(false);
  const [spinnerIdx, setSpinnerIdx] = createSignal(0);
  const [activeModal, setActiveModal] = createSignal<'none' | 'model_picker' | 'session_drawer' | 'command_palette' | 'theme_picker' | 'which_key'>('none');
  const [selectedModel, setSelectedModel] = createSignal(chatRouter.getDefaultModel());
  const [messages, setMessages] = createSignal(sessionStore.getActiveSession().messages);
  const [sidebarPref, setSidebarPref] = createSignal(true);

  // Responsive Breakpoints derived from reactive terminal dimensions
  const showSidebar = () => sidebarPref() && dimensions().width >= 80;
  const sidebarWidth = () => Math.min(32, Math.floor(dimensions().width * 0.25));

  // Reactive Animated Thinking Spinner Ticker
  createEffect(() => {
    if (isBusy()) {
      const timer = setInterval(() => {
        setSpinnerIdx((i) => (i + 1) % SPINNER_FRAMES.length);
      }, 80);
      onCleanup(() => clearInterval(timer));
    }
  });

  const selectModel = (modelName: string) => {
    const resolved = chatRouter.resolveModel(modelName);
    if (resolved) {
      chatRouter.setDefaultModel(resolved);
      setSelectedModel(resolved);
      sessionStore.addMessage('system', `Switched active model to: ${resolved}`);
      setMessages([...sessionStore.getActiveSession().messages]);
    }
    setActiveModal('none');
  };

  const selectTheme = (themeName: string) => {
    themeStore.setTheme(themeName);
    sessionStore.addMessage('system', `Switched active theme to: ${themeName}`);
    setMessages([...sessionStore.getActiveSession().messages]);
    setActiveModal('none');
  };

  // Keyboard router: Full typing, shortcuts, cursor navigation & mouse wheel scroll
  useKeyboard((key) => {
    if (key.ctrl && key.name === 'c') {
      process.exit(0);
    }
    if (key.ctrl && key.name === 'p') {
      setActiveModal(activeModal() === 'command_palette' ? 'none' : 'command_palette');
      return;
    }
    if (key.ctrl && key.name === 'm') {
      setActiveModal(activeModal() === 'model_picker' ? 'none' : 'model_picker');
      return;
    }
    if (key.ctrl && key.name === 't') {
      setActiveModal(activeModal() === 'theme_picker' ? 'none' : 'theme_picker');
      return;
    }
    if (key.ctrl && key.name === 'b') {
      setSidebarPref(!sidebarPref());
      return;
    }

    // Transcript Mouse Wheel Scroll & PageUp / PageDown
    const raw = key.raw || key.sequence || '';
    if (key.name === 'pageup' || raw.includes('<64;') || raw.startsWith('\x1b[<64')) {
      setScrollOffset((s) => s + 3);
      return;
    }
    if (key.name === 'pagedown' || raw.includes('<65;') || raw.startsWith('\x1b[<65')) {
      setScrollOffset((s) => Math.max(0, s - 3));
      return;
    }

    // Modal navigation
    if (activeModal() !== 'none') {
      if (key.name === 'escape') {
        setActiveModal('none');
        return;
      }
      const modal = activeModal();
      if (modal === 'model_picker') {
        if (key.name === '1') { selectModel('claude-3-7-sonnet'); return; }
        if (key.name === '2') { selectModel('gpt-4o'); return; }
        if (key.name === '3') { selectModel('gemini-2.0-flash'); return; }
        if (key.name === '4') { selectModel('claude-cli'); return; }
        if (key.name === '5') { selectModel('deepseek-r1'); return; }
      }
      if (modal === 'theme_picker') {
        if (key.name === '1') { selectTheme('opencode-dark'); return; }
        if (key.name === '2') { selectTheme('dracula'); return; }
        if (key.name === '3') { selectTheme('catppuccin'); return; }
        if (key.name === '4') { selectTheme('monokai'); return; }
        if (key.name === '5') { selectTheme('tokyo-night'); return; }
      }
      if (modal === 'command_palette') {
        if (key.name === '1') { setActiveModal('model_picker'); return; }
        if (key.name === '2') { setActiveModal('theme_picker'); return; }
        if (key.name === '3') { setActiveModal('session_drawer'); return; }
        if (key.name === '4') { sessionStore.compactContext(); setMessages([...sessionStore.getActiveSession().messages]); setActiveModal('none'); return; }
        if (key.name === '5') { sessionStore.clearActiveSession(); setMessages([]); setActiveModal('none'); return; }
      }
      if (modal === 'session_drawer') {
        if (key.name === '1' || key.name === 'n') {
          sessionStore.createSession('New Session');
          setMessages([...sessionStore.getActiveSession().messages]);
          setActiveModal('none');
          return;
        }
      }
      return;
    }

    // Normal Input Handling & Prompt Navigation
    if (key.name === 'escape') {
      setPrompt('');
      setCursorPos(0);
      if (promptQueue().length > 0) setPromptQueue([]);
      return;
    }

    if (key.name === 'left') {
      setCursorPos((c) => Math.max(0, c - 1));
      return;
    }

    if (key.name === 'right') {
      setCursorPos((c) => Math.min(prompt().length, c + 1));
      return;
    }

    if (key.name === 'home') {
      setCursorPos(0);
      return;
    }

    if (key.name === 'end') {
      setCursorPos(prompt().length);
      setScrollOffset(0);
      return;
    }

    if (key.name === 'return' || key.name === 'enter') {
      handleSubmit();
      return;
    }

    if (key.name === 'backspace') {
      const c = cursorPos();
      if (c > 0) {
        setPrompt((p) => p.slice(0, c - 1) + p.slice(c));
        setCursorPos((prev) => Math.max(0, prev - 1));
      }
      return;
    }

    if (key.name === 'delete') {
      const c = cursorPos();
      setPrompt((p) => p.slice(0, c) + p.slice(c + 1));
      return;
    }

    // Capture character typing (including / to trigger slash commands)
    if (!key.ctrl && !key.meta) {
      const char = key.sequence || (key.name && key.name.length === 1 ? key.name : null);
      if (char && char.length === 1 && char >= ' ' && char <= '~') {
        const c = cursorPos();
        setPrompt((p) => p.slice(0, c) + char + p.slice(c));
        setCursorPos((prev) => prev + 1);
      }
    }
  });

  // Prompt Submit: Handles Slash Commands (/) and Non-Blocking Queueing
  const handleSubmit = () => {
    const text = prompt().trim();
    if (!text) return;

    setPrompt('');
    setCursorPos(0);
    setScrollOffset(0);

    // Slash Commands Execution (/model, /theme, /sessions, /palette, /help, /clear, /compact, /quit)
    if (text.startsWith('/')) {
      const [cmd, ...args] = text.split(/\s+/);
      const command = cmd.toLowerCase();
      switch (command) {
        case '/':
        case '/palette':
        case '/commands':
          setActiveModal('command_palette');
          return;
        case '/model':
        case '/models':
          if (args.length > 0) {
            selectModel(args.join(' '));
          } else {
            setActiveModal('model_picker');
          }
          return;
        case '/theme':
        case '/themes':
          if (args.length > 0) {
            selectTheme(args.join(' '));
          } else {
            setActiveModal('theme_picker');
          }
          return;
        case '/session':
        case '/sessions':
          setActiveModal('session_drawer');
          return;
        case '/help':
        case '/keys':
          setActiveModal('which_key');
          return;
        case '/clear':
          sessionStore.clearActiveSession();
          setMessages([]);
          return;
        case '/compact':
          sessionStore.compactContext();
          setMessages([...sessionStore.getActiveSession().messages]);
          return;
        case '/exit':
        case '/quit':
          process.exit(0);
          return;
      }
    }

    sessionStore.addMessage('user', text);
    setMessages([...sessionStore.getActiveSession().messages]);

    // Enqueue prompt without blocking typing!
    setPromptQueue((q) => [...q, text]);
  };

  // Queue Consumer: Drains prompt queue sequentially as streams complete
  createEffect(() => {
    if (isBusy() || promptQueue().length === 0) return;

    const queueItems = promptQueue();
    const nextPrompt = queueItems[0];
    setPromptQueue(queueItems.slice(1));

    void executeStreamTurn(nextPrompt);
  });

  const executeStreamTurn = async (userPrompt: string) => {
    setIsBusy(true);
    try {
      let assistantText = '';
      const activeMsgs = sessionStore.getActiveSession().messages;

      for await (const chunk of chatRouter.dispatch(activeMsgs)) {
        if (chunk.delta) {
          assistantText += chunk.delta;
          setMessages([
            ...sessionStore.getActiveSession().messages,
            { id: 'transient', role: 'assistant', content: assistantText, timestamp: Date.now() }
          ]);
        }
      }

      if (assistantText) {
        sessionStore.addMessage('assistant', assistantText);
        setMessages([...sessionStore.getActiveSession().messages]);
      }
    } catch (e: any) {
      sessionStore.addMessage('system', `Error: ${e.message}`);
      setMessages([...sessionStore.getActiveSession().messages]);
    } finally {
      setIsBusy(false);
    }
  };

  const renderedPromptWithCursor = () => {
    const p = prompt();
    const c = Math.max(0, Math.min(p.length, cursorPos()));
    return p.slice(0, c) + '█' + p.slice(c);
  };

  const visibleMessages = () => {
    const msgs = messages();
    if (scrollOffset() === 0) return msgs;
    const end = Math.max(1, msgs.length - scrollOffset());
    return msgs.slice(0, end);
  };

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor="#0f172a">
      {/* Top Header Tab Bar */}
      <box flexDirection="row" width="100%" height={1} backgroundColor="#1e293b">
        <text color="#38bdf8" bold> SAURON v2.0 OPENCODE TUI </text>
        <text color="#64748b"> │ active: {sessionStore.getActiveSession().title} │ </text>
        <text color="#a855f7"> model: {selectedModel()} </text>
        <text color="#64748b"> (type / for palette, ctrl+p, ctrl+b sidebar, ctrl+c quit) </text>
      </box>

      {/* Main Area: Responsive Sidebar + Scrollbox Transcript */}
      <box flexDirection="row" flexGrow={1} width="100%">
        {/* Responsive Sidebar (collapses on <80 cols) */}
        <Show when={showSidebar()}>
          <box flexDirection="column" width={sidebarWidth()} borderStyle="single" borderColor="#334155" padding={1}>
            <text color="#38bdf8" bold>TACTICAL SIDEBAR</text>
            <text color="#64748b">───────────────</text>
            <text color="#e2e8f0">Catalog: 8 models</text>
            <text color="#e2e8f0">Sessions: {sessionStore.listSessions().length}</text>
            <text color="#4ade80">MCP: Active (2)</text>
            <text color="#a855f7">Playbooks: 3 ready</text>
            <text color="#64748b">Width: {dimensions().width} cols</text>
          </box>
        </Show>

        {/* Flexible Scrollbox Transcript Pane */}
        <scrollbox flexGrow={1} height="100%" borderStyle="single" borderColor="#334155" padding={1}>
          <Show when={scrollOffset() > 0}>
            <text color="#facc15" bold> ▲ SCROLLED UP ({scrollOffset()} msgs) - Press End or type to return to bottom </text>
          </Show>
          <For each={visibleMessages()}>
            {(msg) => (
              <box flexDirection="column" marginBottom={1}>
                <text color={msg.role === 'user' ? '#38bdf8' : msg.role === 'assistant' ? '#a855f7' : '#64748b'} bold>
                  [{msg.role.toUpperCase()}] {new Date(msg.timestamp).toLocaleTimeString()}
                </text>
                <text color="#e2e8f0">  {msg.content}</text>
              </box>
            )}
          </For>
        </scrollbox>
      </box>

      {/* Inline Slash Command Auto-Complete Box (triggers when prompt starts with /) */}
      <Show when={prompt().startsWith('/') && activeModal() === 'none'}>
        <box flexDirection="column" width="100%" backgroundColor="#0284c7" padding={1}>
          <text color="#ffffff" bold> SLASH COMMAND AUTOCOMPLETE (Press Enter to execute) </text>
          <text color="#e0f2fe"> /model [name]   - Select AI model (1: claude-3-7-sonnet, 2: gpt-4o, 3: gemini-2.0-flash) </text>
          <text color="#e0f2fe"> /theme [name]   - Change UI theme (1: opencode-dark, 2: dracula, 3: catppuccin) </text>
          <text color="#e0f2fe"> /sessions       - Open sessions drawer </text>
          <text color="#e0f2fe"> /compact        - Compact context memory </text>
          <text color="#e0f2fe"> /clear          - Clear transcript </text>
        </box>
      </Show>

      {/* Bottom Prompt Input Area (Non-Blocking) */}
      <box flexDirection="column" width="100%" height={4} borderStyle="single" borderColor="#38bdf8">
        <box flexDirection="row" width="100%">
          <text color="#38bdf8" bold> PROMPT &gt; </text>
          <text color="#e2e8f0">{renderedPromptWithCursor()}</text>
        </box>
        <box flexDirection="row" width="100%" backgroundColor="#1e293b">
          <text color={isBusy() ? '#facc15' : '#4ade80'}>
            {isBusy() ? `${SPINNER_FRAMES[spinnerIdx()]} Assistant thinking & streaming...` : '● Ready'} │ Model: {selectedModel()}
          </text>
          <Show when={promptQueue().length > 0}>
            <text color="#a855f7" bold> │ Queued Prompts: {promptQueue().length} </text>
          </Show>
          <text color="#64748b"> │ Type / for commands palette </text>
        </box>
      </box>

      {/* Responsive Centered Modal Overlay: Command Palette */}
      <Show when={activeModal() === 'command_palette'}>
        <box
          position="absolute"
          top={Math.max(2, Math.floor((dimensions().height - 16) / 2))}
          left={Math.max(2, Math.floor((dimensions().width - 64) / 2))}
          width={Math.min(64, dimensions().width - 4)}
          height={16}
          borderStyle="double"
          borderColor="#38bdf8"
          backgroundColor="#0f172a"
          flexDirection="column"
          padding={1}
        >
          <text color="#38bdf8" bold> SLASH COMMANDS & PALETTE (/) </text>
          <text color="#64748b">────────────────────────────</text>
          <text color="#e2e8f0"> 1. Switch AI Model (/model) </text>
          <text color="#e2e8f0"> 2. Theme Selector (/theme) </text>
          <text color="#e2e8f0"> 3. Sessions Drawer (/sessions) </text>
          <text color="#e2e8f0"> 4. Compact Context Memory (/compact) </text>
          <text color="#e2e8f0"> 5. Clear Current Transcript (/clear) </text>
          <text color="#f87171"> Press 1-5 to select, or Escape to close </text>
        </box>
      </Show>

      {/* Responsive Centered Modal Overlay: Model Picker */}
      <Show when={activeModal() === 'model_picker'}>
        <box
          position="absolute"
          top={Math.max(2, Math.floor((dimensions().height - 16) / 2))}
          left={Math.max(2, Math.floor((dimensions().width - 64) / 2))}
          width={Math.min(64, dimensions().width - 4)}
          height={16}
          borderStyle="double"
          borderColor="#38bdf8"
          backgroundColor="#0f172a"
          flexDirection="column"
          padding={1}
        >
          <text color="#38bdf8" bold> MODEL SELECTOR PICKER (/model) </text>
          <text color="#64748b">────────────────────────────</text>
          <text color="#a855f7" bold> 1. claude-3-7-sonnet [Anthropic] </text>
          <text color="#e2e8f0"> 2. gpt-4o [OpenAI] </text>
          <text color="#e2e8f0"> 3. gemini-2.0-flash [Gemini] </text>
          <text color="#e2e8f0"> 4. claude-cli [Local CLI] </text>
          <text color="#e2e8f0"> 5. deepseek-r1 [DeepSeek] </text>
          <text color="#f87171"> Press 1-5 to pick model, or Escape to close </text>
        </box>
      </Show>

      {/* Responsive Centered Modal Overlay: Theme Picker */}
      <Show when={activeModal() === 'theme_picker'}>
        <box
          position="absolute"
          top={Math.max(2, Math.floor((dimensions().height - 16) / 2))}
          left={Math.max(2, Math.floor((dimensions().width - 64) / 2))}
          width={Math.min(64, dimensions().width - 4)}
          height={16}
          borderStyle="double"
          borderColor="#38bdf8"
          backgroundColor="#0f172a"
          flexDirection="column"
          padding={1}
        >
          <text color="#38bdf8" bold> THEME SELECTOR PICKER (/theme) </text>
          <text color="#64748b">────────────────────────────</text>
          <text color="#e2e8f0"> 1. opencode-dark (Default OpenCode) </text>
          <text color="#e2e8f0"> 2. dracula </text>
          <text color="#e2e8f0"> 3. catppuccin </text>
          <text color="#e2e8f0"> 4. monokai </text>
          <text color="#e2e8f0"> 5. tokyo-night </text>
          <text color="#f87171"> Press 1-5 to pick theme, or Escape to close </text>
        </box>
      </Show>
    </box>
  );
}

export async function startOpenTUI() {
  if (process.stdout.isTTY) {
    const engine = new OpenCodeEngine();
    engine.start();
  } else {
    await render(() => <OpenTUIApp />, { targetFps: 30, exitOnCtrlC: false });
  }
}

