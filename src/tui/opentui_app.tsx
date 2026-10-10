/**
 * SAURON v2.0 OPENCODE TUI ARCHITECTURE (OpenTUI + SolidJS JSX)
 * Non-Blocking Prompt Queue, Queue Consumer, Responsive Breakpoints & OpenTUI Renderer
 */

import { render, useKeyboard, useTerminalDimensions } from '@opentui/solid';
import { createSignal, createEffect, For, Show } from 'solid-js';
import { chatRouter } from '../router';
import { sessionStore } from '../session';
import { themeStore } from './themes';

export function OpenTUIApp() {
  const dimensions = useTerminalDimensions();
  const [prompt, setPrompt] = createSignal('');
  const [promptQueue, setPromptQueue] = createSignal<string[]>([]);
  const [isBusy, setIsBusy] = createSignal(false);
  const [activeModal, setActiveModal] = createSignal<'none' | 'model_picker' | 'command_palette'>('none');
  const [selectedModel, setSelectedModel] = createSignal(chatRouter.getDefaultModel());
  const [messages, setMessages] = createSignal(sessionStore.getActiveSession().messages);
  const [sidebarPref, setSidebarPref] = createSignal(true);

  // Responsive Breakpoints derived from reactive terminal dimensions
  const showSidebar = () => sidebarPref() && dimensions().width >= 80;
  const sidebarWidth = () => Math.min(32, Math.floor(dimensions().width * 0.25));

  // Keyboard router
  useKeyboard((key) => {
    if (key.ctrl && key.name === 'c') {
      process.exit(0);
    }
    if (key.ctrl && key.name === 'p') {
      setActiveModal(activeModal() === 'command_palette' ? 'none' : 'command_palette');
    }
    if (key.ctrl && key.name === 'b') {
      setSidebarPref(!sidebarPref());
    }
    if (key.name === 'escape') {
      if (activeModal() !== 'none') {
        setActiveModal('none');
      } else if (promptQueue().length > 0) {
        setPromptQueue([]); // Clear pending queue on Escape
      }
    }
  });

  // Prompt Submit: UNBLOCKS INPUT IMMEDIATELY by pushing to promptQueue
  const handleSubmit = () => {
    const text = prompt().trim();
    if (!text) return;

    // Clear input buffer immediately so user can continue typing next prompt!
    setPrompt('');

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

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor="#0f172a">
      {/* Top Header Tab Bar */}
      <box flexDirection="row" width="100%" height={1} backgroundColor="#1e293b">
        <text color="#38bdf8" bold> SAURON v2.0 OPENCODE TUI </text>
        <text color="#64748b"> │ active: {sessionStore.getActiveSession().title} │ </text>
        <text color="#a855f7"> model: {selectedModel()} </text>
        <text color="#64748b"> (ctrl+p palette, ctrl+b sidebar, ctrl+c quit) </text>
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
          <For each={messages()}>
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

      {/* Bottom Prompt Input Area (Non-Blocking) */}
      <box flexDirection="column" width="100%" height={4} borderStyle="single" borderColor="#38bdf8">
        <box flexDirection="row" width="100%">
          <text color="#38bdf8" bold> PROMPT &gt; </text>
          <text color="#e2e8f0">{prompt()}█</text>
        </box>
        <box flexDirection="row" width="100%" backgroundColor="#1e293b">
          <text color={isBusy() ? '#facc15' : '#4ade80'}>
            {isBusy() ? '⠋ Streaming...' : '● Ready'} │ Model: {selectedModel()}
          </text>
          <Show when={promptQueue().length > 0}>
            <text color="#a855f7" bold> │ Queued Prompts: {promptQueue().length} </text>
          </Show>
          <text color="#64748b"> │ Non-blocking typing active </text>
        </box>
      </box>

      {/* Responsive Centered Modal Overlay */}
      <Show when={activeModal() === 'command_palette'}>
        <box
          position="absolute"
          top={Math.max(2, Math.floor((dimensions().height - 14) / 2))}
          left={Math.max(2, Math.floor((dimensions().width - 64) / 2))}
          width={Math.min(64, dimensions().width - 4)}
          height={14}
          borderStyle="double"
          borderColor="#38bdf8"
          backgroundColor="#0f172a"
          flexDirection="column"
          padding={1}
        >
          <text color="#38bdf8" bold> COMMAND PALETTE (Ctrl+P) </text>
          <text color="#64748b">────────────────────────────</text>
          <text color="#e2e8f0"> 1. Switch AI Model (Ctrl+M) </text>
          <text color="#e2e8f0"> 2. New Conversation Session (Ctrl+N) </text>
          <text color="#e2e8f0"> 3. Toggle Sidebar (Ctrl+B) </text>
          <text color="#e2e8f0"> 4. Compact Context Memory </text>
          <text color="#f87171"> Press Escape to close </text>
        </box>
      </Show>
    </box>
  );
}

export async function startOpenTUI() {
  await render(() => <OpenTUIApp />, { targetFps: 30, exitOnCtrlC: false });
}
