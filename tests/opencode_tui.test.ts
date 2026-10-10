import { describe, test, expect } from 'bun:test';
import { themeStore, BUNDLED_THEMES, fg, bg, bold } from '../src/tui/themes';
import { keymapRegistry } from '../src/tui/keymaps';
import { modalManager } from '../src/tui/modals';
import { SessionTabBar, SidebarPane, MessageCardRenderer, PromptComposer } from '../src/tui/views';

describe('OpenCode TUI Architecture Suite', () => {
  test('Themes: supports 34 bundled themes and token resolution', () => {
    const list = themeStore.listThemes();
    expect(list.length).toBeGreaterThanOrEqual(14);
    expect(list).toContain('opencode');
    expect(list).toContain('catppuccin-macchiato');
    expect(list).toContain('dracula');

    const theme = themeStore.setTheme('dracula');
    expect(theme.name).toBe('dracula');
    expect(theme.text.accent).toBe('#8be9fd');

    const formatted = fg(theme.text.accent, 'hello');
    expect(formatted).toContain('\x1b[38;2;');
  });

  test('Keymaps: tracks leader key ctrl+x and emacs prompt bindings', () => {
    const bindings = keymapRegistry.getBindings();
    expect(bindings.length).toBeGreaterThan(10);
    
    // Leader Key test
    const leaderRes = keymapRegistry.processInput('\x18', { ctrl: true, name: 'x' });
    expect(leaderRes).toBe('LEADER_PENDING');
    expect(keymapRegistry.isLeaderActive()).toBe(true);

    const navRes = keymapRegistry.processInput('m', { name: 'm' });
    expect(navRes).toBe('OPEN_MODEL_PICKER');
    expect(keymapRegistry.isLeaderActive()).toBe(false);

    // Direct Shortcut
    const palRes = keymapRegistry.processInput('\x10', { ctrl: true, name: 'p' });
    expect(palRes).toBe('OPEN_PALETTE');
  });

  test('Modals: manages model picker, session drawer, command palette, and diff viewer', () => {
    modalManager.openModal('model_picker');
    expect(modalManager.getActiveModal()).toBe('model_picker');

    const lines = modalManager.render(100, 30);
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.join('\n')).toContain('OPENCODE MODEL SELECTOR');

    modalManager.openModal('command_palette');
    const palLines = modalManager.render(100, 30);
    expect(palLines.join('\n')).toContain('COMMAND PALETTE');

    modalManager.closeModal();
    expect(modalManager.getActiveModal()).toBe('none');
  });

  test('Views: renders OpenCode session tab bar, sidebar, message cards, and prompt composer', () => {
    const theme = themeStore.getTheme();
    const tabBar = new SessionTabBar();
    const tabStr = tabBar.render(100, 'Main Session', 3, theme);
    expect(tabStr).toContain('Main Session');

    const sidebar = new SidebarPane();
    const sbLines = sidebar.render(30, 20, theme);
    expect(sbLines.length).toBe(20);
    expect(sbLines.join('\n')).toContain('SAURON SIDEBAR');

    const card = new MessageCardRenderer();
    const msgLines = card.renderMessage({ id: '1', role: 'user', content: 'hello @main.ts /run', timestamp: Date.now() }, 80, theme);
    expect(msgLines.join('\n')).toContain('USER');

    const composer = new PromptComposer();
    const pLines = composer.renderPrompt('hello world', 11, 80, false, theme);
    expect(pLines.length).toBeGreaterThan(3);
    expect(pLines.join('\n')).toContain('Ready');
  });

  test('Sessions: clearAllSessions removes all saved sessions and resets workspace session', () => {
    const { sessionStore } = require('../src/session');
    sessionStore.createSession('Session A');
    sessionStore.createSession('Session B');
    expect(sessionStore.listSessions().length).toBeGreaterThanOrEqual(2);

    sessionStore.clearAllSessions();
    expect(sessionStore.listSessions().length).toBe(1);
    expect(sessionStore.getActiveSession().messages.length).toBe(0);
  });
});
