/** Small DOM helpers. The UI is plain DOM, with no framework. */

type Child = Node | string | null | undefined | false;

export interface Props {
  class?: string;
  text?: string;
  html?: string;
  title?: string;
  /** Tooltip text, shown by the shared tooltip. */
  tip?: string;
  /** Hotkey named in the tooltip. */
  keyHint?: string;
  /** A second line in the tooltip, under the name. */
  desc?: string;
  style?: Partial<CSSStyleDeclaration>;
  attrs?: Record<string, string>;
  dataset?: Record<string, string>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (e: HTMLElementEventMap[K]) => void }>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.html !== undefined) node.innerHTML = props.html;
  if (props.title) node.title = props.title;
  if (props.tip) node.dataset.tip = props.tip;
  if (props.keyHint) node.dataset.key = props.keyHint;
  if (props.desc) node.dataset.desc = props.desc;
  if (props.style) Object.assign(node.style, props.style);
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) node.setAttribute(k, v);
  if (props.dataset) Object.assign(node.dataset, props.dataset);
  if (props.on) {
    for (const [type, fn] of Object.entries(props.on)) node.addEventListener(type, fn as EventListener);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

export function iconButton(
  icon: string,
  opts: { tip: string; keyHint?: string; desc?: string; class?: string; onClick: () => void; label?: string },
): HTMLButtonElement {
  return el(
    'button',
    {
      class: `icon-btn ${opts.class ?? ''}`,
      tip: opts.tip,
      keyHint: opts.keyHint,
      desc: opts.desc,
      html: icon + (opts.label ? `<span>${opts.label}</span>` : ''),
      attrs: { type: 'button', 'aria-label': opts.tip },
      on: {
        click: () => {
          opts.onClick();
        },
      },
    },
  );
}

/** Labelled form row. */
export function row(label: string, control: Node, tip?: string): HTMLElement {
  return el('label', { class: 'field', tip }, el('span', { class: 'field-label', text: label }), control);
}

export function selectInput<T extends string>(
  options: readonly { value: T; label: string }[],
  value: T,
  onChange: (value: T) => void,
): HTMLSelectElement {
  const select = el('select', {
    on: {
      change: () => {
        onChange(select.value as T);
        select.blur();
      },
    },
  });
  for (const o of options) select.append(el('option', { text: o.label, attrs: { value: o.value } }));
  select.value = value;
  return select;
}

/** Number box. Fires on each valid edit. */
export function numberInput(value: number, opts: { min?: number; max?: number; step?: number }, onChange: (v: number) => void): HTMLInputElement {
  const input = el('input', {
    attrs: {
      type: 'number',
      ...(opts.min !== undefined ? { min: String(opts.min) } : {}),
      ...(opts.max !== undefined ? { max: String(opts.max) } : {}),
      step: String(opts.step ?? 1),
    },
    on: {
      input: () => {
        const v = input.valueAsNumber;
        if (Number.isFinite(v)) onChange(v);
      },
    },
  });
  input.value = String(value);
  return input;
}

/** Range slider with a value readout. */
export function sliderInput(
  value: number,
  opts: { min: number; max: number; step: number; format?: (v: number) => string },
  onChange: (v: number) => void,
): HTMLElement {
  const fmt = opts.format ?? ((v: number) => String(v));
  const out = el('output', { text: fmt(value) });
  const input = el('input', {
    attrs: { type: 'range', min: String(opts.min), max: String(opts.max), step: String(opts.step) },
    on: {
      input: () => {
        const v = input.valueAsNumber;
        out.textContent = fmt(v);
        onChange(v);
      },
      change: () => input.blur(),
    },
  });
  input.value = String(value);
  // The filled part of the track, for the custom slider style.
  const fill = () => input.style.setProperty('--fill', `${((input.valueAsNumber - opts.min) / (opts.max - opts.min || 1)) * 100}%`);
  input.addEventListener('input', fill);
  input.addEventListener('sync', fill);
  fill();
  return el('span', { class: 'slider' }, input, out);
}

export function textInput(value: string, placeholder: string, onChange: (v: string) => void): HTMLInputElement {
  const input = el('input', {
    attrs: { type: 'text', placeholder, spellcheck: 'false' },
    on: { input: () => onChange(input.value) },
  });
  input.value = value;
  return input;
}

export function checkbox(value: boolean, onChange: (v: boolean) => void): HTMLInputElement {
  const input = el('input', { attrs: { type: 'checkbox' }, on: { change: () => { onChange(input.checked); input.blur(); } } });
  input.checked = value;
  return input;
}

/** Canvas sized for the device pixel ratio. Draw in CSS pixels. */
export function hiDpiCanvas(width: number, height: number, cls?: string): HTMLCanvasElement {
  const canvas = el('canvas', { class: cls });
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.getContext('2d')?.scale(ratio, ratio);
  return canvas;
}

export interface VisualOption<T> {
  value: T;
  label: string;
  preview: string;
}

let openPopup: HTMLElement | null = null;

export function closePopups(): boolean {
  if (!openPopup) return false;
  openPopup.remove();
  openPopup = null;
  return true;
}

document.addEventListener('pointerdown', (e) => {
  if (openPopup && !openPopup.contains(e.target as Node)) closePopups();
}, true);

/** A dropdown whose options carry a small drawing. */
export function visualSelect<T>(options: readonly VisualOption<T>[], value: T, onChange: (value: T) => void): HTMLElement {
  const current = options.find((o) => o.value === value) ?? options[0];
  const button = el('button', {
    class: 'vselect',
    attrs: { type: 'button', 'aria-haspopup': 'listbox' },
    html: `<span class="vselect-art">${current.preview}</span><span class="vselect-name">${current.label}</span><span class="vselect-caret">▾</span>`,
  });
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (closePopups()) return;
    const list = el('div', { class: 'vselect-list', attrs: { role: 'listbox' } });
    for (const option of options) {
      list.append(
        el('button', {
          class: `vselect-option ${option.value === value ? 'selected' : ''}`,
          attrs: { type: 'button', role: 'option' },
          html: `<span class="vselect-art">${option.preview}</span><span class="vselect-name">${option.label}</span>`,
          on: {
            click: () => {
              closePopups();
              onChange(option.value);
            },
          },
        }),
      );
    }
    document.body.append(list);
    const r = button.getBoundingClientRect();
    const height = list.offsetHeight;
    list.style.left = `${Math.min(r.left, window.innerWidth - list.offsetWidth - 8)}px`;
    list.style.top = `${r.bottom + height + 8 > window.innerHeight ? Math.max(8, r.top - height - 4) : r.bottom + 4}px`;
    openPopup = list;
  });
  return button;
}
