/**
 * icons.js — the app's icon set.
 *
 * A single inline SVG sprite, injected once at startup. Emoji were doing this
 * job before, and they are the wrong tool: every platform draws them
 * differently, they cannot inherit the colour of the thing they sit in, they
 * carry a cartoon style the rest of the interface does not, and at small
 * sizes on a phone they turn to mush.
 *
 * These are stroke icons on a 24×24 grid, drawn with `currentColor`, so an
 * icon takes the colour of whatever contains it and stays sharp at any size.
 * Inlined rather than fetched, so there is nothing to load in the field.
 *
 *   SolarisIcons.mount()          put the sprite in the document
 *   SolarisIcons.svg('mic')       markup for one icon, for template strings
 */
(function (root) {
  'use strict';

  // Each entry is the inner markup of a 24×24 symbol.
  const PATHS = {
    // People and kinship
    users: '<circle cx="9" cy="8" r="3.2"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16.5 6.6a3.2 3.2 0 0 1 0 6.1"/><path d="M18 20a6.4 6.4 0 0 0-3-5.4"/>',
    // Animals
    paw: '<ellipse cx="6.5" cy="9" rx="2.1" ry="2.7"/><ellipse cx="17.5" cy="9" rx="2.1" ry="2.7"/><ellipse cx="10.3" cy="5.4" rx="1.9" ry="2.4"/><ellipse cx="15.6" cy="14.4" rx="1.7" ry="2.1"/><path d="M12 12.8c2.8 0 5 1.9 5 4.2 0 1.7-1.4 2.9-3.2 2.9-1.3 0-1.6-.5-2.6-.5s-1.3.5-2.6.5C6.8 19.9 5.4 18.7 5.4 17c0-2.3 2.2-4.2 5-4.2Z"/>',
    // Places
    home: '<path d="M3.5 10.5 12 3.5l8.5 7"/><path d="M5.5 9.6V20h13V9.6"/><path d="M10 20v-5h4v5"/>',
    // Everyday objects
    box: '<path d="M3.5 7.6 12 3.2l8.5 4.4v8.8L12 20.8l-8.5-4.4z"/><path d="M3.5 7.6 12 12l8.5-4.4"/><path d="M12 12v8.8"/>',
    // Time
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.2l3.4 2"/>',
    // Actions and verbs
    steps: '<path d="M7.5 3.5c1.7 0 2.6 1.3 2.6 3.1 0 1.6-.6 2.6-.6 4 0 .9.4 1.4.4 2.3 0 1.2-1 1.9-2.4 1.9s-2.4-.7-2.4-1.9c0-.9.4-1.4.4-2.3 0-1.4-.6-2.4-.6-4 0-1.8.9-3.1 2.6-3.1Z"/><path d="M5.2 18.5c0 1 .9 1.7 2.3 1.7s2.3-.7 2.3-1.7"/><path d="M16.5 7.5c1.7 0 2.6 1.3 2.6 3.1 0 1.6-.6 2.6-.6 4 0 .9.4 1.4.4 2.3"/><path d="M14.2 16.9c0-.9.4-1.4.4-2.3 0-1.4-.6-2.4-.6-4 0-1.8.9-3.1 2.5-3.1"/>',
    // Streak
    flame: '<path d="M12 2.8s5.6 4 5.6 9.1a5.6 5.6 0 1 1-11.2 0c0-2 1-3.6 1.9-4.6.3 1 .9 1.8 1.7 1.8 1.1 0 1.6-1 1.6-2.4 0-1.4-.4-2.6 .4-3.9Z"/><path d="M12 20.4a2.7 2.7 0 0 0 2.7-2.7c0-1.9-2.7-4-2.7-4s-2.7 2.1-2.7 4A2.7 2.7 0 0 0 12 20.4Z"/>',
    // Achievement
    award: '<circle cx="12" cy="9" r="5.5"/><path d="M8.4 13.6 7 21.2l5-2.6 5 2.6-1.4-7.6"/>',
    // Sound
    volume: '<path d="M4.5 9.5h3l4-3.4v11.8l-4-3.4h-3z"/><path d="M15.5 9.4a3.6 3.6 0 0 1 0 5.2"/><path d="M18 7a7 7 0 0 1 0 10"/>',
    // Microphone
    mic: '<rect x="9" y="2.6" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v3.4"/>',
    // Session controls
    play: '<path d="M8 5.2 18.5 12 8 18.8z"/>',
    pause: '<path d="M9 5v14"/><path d="M15 5v14"/>',
    check: '<path d="M4.5 12.8 9.5 18 19.5 6.4"/>',
    rotate: '<path d="M3.8 12a8.2 8.2 0 1 0 2.6-6"/><path d="M3.4 3.6v4.6h4.6"/>',
    ban: '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>',
    close: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
    chevron: '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
    power: '<path d="M12 3.4v8"/><path d="M6.9 6.6a7.6 7.6 0 1 0 10.2 0"/>',
    user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20.2a7.2 7.2 0 0 1 14.4 0"/>',
    cloud: '<path d="M7 18.5a4.2 4.2 0 0 1 .5-8.4 5.6 5.6 0 0 1 10.7 1.4A3.8 3.8 0 0 1 17.6 18.5z"/><path d="M12 20.5v-6"/><path d="M9.6 16.6 12 14.2l2.4 2.4"/>',
    trending: '<path d="M3.5 16.5 9 11l3.5 3.5L20.5 6.5"/><path d="M15.5 6.5h5v5"/>',
    // Abstract ideas
    sparkle: '<path d="M12 3.2 13.9 9 19.7 10.9 13.9 12.8 12 18.6 10.1 12.8 4.3 10.9 10.1 9z"/><path d="M18.4 16.4l.8 2.3 2.3.8-2.3.8-.8 2.3-.8-2.3-2.3-.8 2.3-.8z"/>',
    // Descriptive words
    tag: '<path d="M11.4 3.5H20v8.6l-8.6 8.6a1.7 1.7 0 0 1-2.4 0l-6.2-6.2a1.7 1.7 0 0 1 0-2.4z"/><circle cx="16.2" cy="7.8" r="1.4"/>',
    // Manner and direction
    compass: '<circle cx="12" cy="12" r="8.5"/><path d="M15.6 8.4 13.8 13.8 8.4 15.6 10.2 10.2z"/>',
    // Joining words
    link: '<path d="M10 13.6a3.6 3.6 0 0 0 5.4.4l2.4-2.4a3.6 3.6 0 0 0-5.1-5.1L11.3 8"/><path d="M14 10.4a3.6 3.6 0 0 0-5.4-.4l-2.4 2.4a3.6 3.6 0 0 0 5.1 5.1L12.7 16"/>',
    // Exclamations
    zap: '<path d="M13.4 2.6 4.6 13.4h6.2l-.6 8 8.8-10.8h-6.2z"/>',
    // Counting
    hash: '<path d="M5 9.2h14"/><path d="M5 15h14"/><path d="M10.4 3.6 8.6 20.4"/><path d="M15.9 3.6 14.1 20.4"/>',
    // Whole utterances
    message: '<path d="M20.5 12.4a7.6 7.6 0 0 1-8.2 7.6L4.5 21.2l1.2-6.4a7.6 7.6 0 1 1 14.8-2.4z"/><path d="M9 11h6"/><path d="M9 14.4h3.6"/>',
  };

  let mounted = false;

  function mount() {
    if (mounted || document.getElementById('solaris-icons')) return;
    mounted = true;

    const symbols = Object.entries(PATHS)
      .map(([name, body]) => `<symbol id="i-${name}" viewBox="0 0 24 24">${body}</symbol>`)
      .join('');

    const holder = document.createElement('div');
    holder.id = 'solaris-icons';
    holder.setAttribute('aria-hidden', 'true');
    // Hidden, but not display:none — Safari will not render <use> references
    // into a sprite that has been removed from layout entirely.
    holder.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    holder.innerHTML =
      `<svg xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.9" ` +
      `stroke-linecap="round" stroke-linejoin="round">${symbols}</svg>`;

    document.body.insertBefore(holder, document.body.firstChild);
  }

  /** Markup for one icon. `cls` lands on the <svg> so size and colour are CSS. */
  function svg(name, cls) {
    if (!PATHS[name]) name = 'box';
    return `<svg class="ico${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  }

  const api = { mount, svg, names: () => Object.keys(PATHS) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SolarisIcons = api;
})(typeof self !== 'undefined' ? self : globalThis);
