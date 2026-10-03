"use client";

import { Image as ImageIcon, LoaderCircle, Plus, Trash2, Upload } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import { LINK_ICONS, type BrandLink } from "@/lib/brand-types";
import { Button } from "../shared";

/* Small controlled form pieces for the appearance editor. They reuse the panel's field styles. */

export function TextField({
  label,
  value,
  onChange,
  max,
  hint,
  placeholder,
  multiline = false,
  rows = 3,
  mono = false,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  max?: number;
  hint?: ReactNode;
  placeholder?: string;
  multiline?: boolean;
  rows?: number;
  mono?: boolean;
  type?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {multiline ? (
        <textarea id={id} className={`input${mono ? " ap-mono" : ""}`} rows={rows} value={value} maxLength={max} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} spellCheck={!mono} />
      ) : (
        <input id={id} className="input" type={type} value={value} maxLength={max} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
      {hint || max ? (
        <span className="field__hint">
          {hint}
          {max && value.length > max * 0.8 ? <span className="ap-count"> {value.length}/{max}</span> : null}
        </span>
      ) : null}
    </div>
  );
}

export function ColorField({ label, value, onChange, hint, placeholder }: { label: string; value: string; onChange: (v: string) => void; hint?: ReactNode; placeholder?: string }) {
  const id = useId();
  const valid = /^#[0-9a-fA-F]{6}$/.test(value);
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <div className="ap-color">
        <input className="ap-color__swatch" type="color" aria-label={`${label}, colour picker`} value={valid ? value : placeholder && /^#[0-9a-fA-F]{6}$/.test(placeholder) ? placeholder : "#000000"} onChange={(e) => onChange(e.target.value)} />
        <input id={id} className="input ap-mono" value={value} placeholder={placeholder} maxLength={7} spellCheck={false} onChange={(e) => onChange(e.target.value.trim())} aria-invalid={value !== "" && !valid} />
      </div>
      {hint ? <span className="field__hint">{hint}</span> : null}
    </div>
  );
}

export function RangeField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  hint,
  display,
  track,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  hint?: ReactNode;
  display?: string;
  track?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <div className="ap-range__head">
        <label className="field__label" htmlFor={id}>
          {label}
        </label>
        <output htmlFor={id} className="ap-range__value">
          {display ?? value}
        </output>
      </div>
      <input id={id} className="ap-range" type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} style={track ? { background: track } : undefined} />
      {hint ? <span className="field__hint">{hint}</span> : null}
    </div>
  );
}

/** A group of option cards: one choice, with a short description each. */
export function Choice<T extends string | number>({
  label,
  value,
  onChange,
  options,
  columns = 3,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; hint?: ReactNode; style?: React.CSSProperties }[];
  columns?: number;
}) {
  return (
    <div className="field" role="radiogroup" aria-label={label}>
      <span className="field__label">{label}</span>
      <div className="ap-choice" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {options.map((o) => (
          <button key={String(o.value)} type="button" role="radio" aria-checked={value === o.value} className="ap-choice__item" onClick={() => onChange(o.value)}>
            <span className="ap-choice__label" style={o.style}>
              {o.label}
            </span>
            {o.hint ? <small>{o.hint}</small> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SwitchRow({ label, hint, checked, onChange, disabled = false }: { label: string; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="ap-switchrow">
      <div>
        <label htmlFor={id} className="field__label">
          {label}
        </label>
        {hint ? <span className="field__hint">{hint}</span> : null}
      </div>
      <button id={id} type="button" role="switch" className="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} />
    </div>
  );
}

/** Editable list of links (label, address, icon, new tab). */
export function LinkList({ label, value, onChange, max, empty }: { label: string; value: BrandLink[]; onChange: (v: BrandLink[]) => void; max: number; empty: string }) {
  const set = (i: number, patch: Partial<BrandLink>) => onChange(value.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      {value.length === 0 ? <p className="field__hint">{empty}</p> : null}
      <ul className="ap-links">
        {value.map((l, i) => (
          <li key={i} className="ap-link">
            <input className="input" aria-label={`Link ${i + 1} label`} placeholder="Label" maxLength={40} value={l.label} onChange={(e) => set(i, { label: e.target.value })} />
            <input className="input" aria-label={`Link ${i + 1} address`} placeholder="https://" maxLength={500} value={l.url} onChange={(e) => set(i, { url: e.target.value.trim() })} />
            <select className="input select" aria-label={`Link ${i + 1} icon`} value={l.icon} onChange={(e) => set(i, { icon: e.target.value })}>
              {LINK_ICONS.map((ic) => (
                <option key={ic} value={ic}>
                  {ic.replace("-", " ")}
                </option>
              ))}
            </select>
            <label className="ap-link__tab">
              <input type="checkbox" checked={l.newTab} onChange={(e) => set(i, { newTab: e.target.checked })} /> New tab
            </label>
            <button type="button" className="btn btn--ghost btn--icon" aria-label={`Remove link ${i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <Trash2 />
            </button>
          </li>
        ))}
      </ul>
      {value.length < max ? (
        <div>
          <Button size="sm" onClick={() => onChange([...value, { label: "", url: "https://", icon: "link", newTab: true }])}>
            <Plus /> Add a link
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** One image slot: shows the current image and uploads a new one to the server (it is used once the appearance is saved). */
export function ImageSlot({
  label,
  hint,
  src,
  accept,
  maxKb,
  onFile,
  onRemove,
  wide = false,
}: {
  label: string;
  hint: ReactNode;
  src: string | null;
  accept: string;
  maxKb: number;
  onFile: (file: File) => Promise<void>;
  onRemove: () => void;
  wide?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const id = useId();
  return (
    <div className="field">
      <span className="field__label" id={id}>
        {label}
      </span>
      <div className={`ap-image${wide ? " ap-image--wide" : ""}`}>
        <div className="ap-image__frame" aria-hidden="true">
          {src ? <img src={src} alt="" /> : <ImageIcon />}
        </div>
        <div className="ap-image__actions">
          <input
            ref={input}
            type="file"
            accept={accept}
            hidden
            aria-labelledby={id}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              if (file.size > maxKb * 1024) {
                setError(`This file is ${Math.ceil(file.size / 1024)} KB; the limit is ${maxKb} KB.`);
                return;
              }
              setBusy(true);
              setError("");
              try {
                await onFile(file);
              } catch (ex) {
                setError((ex as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          />
          <Button size="sm" busy={busy} onClick={() => input.current?.click()}>
            {busy ? null : <Upload />} {src ? "Replace" : "Upload"}
          </Button>
          {src ? (
            <Button size="sm" variant="ghost" onClick={onRemove} disabled={busy}>
              Remove
            </Button>
          ) : null}
          {busy ? <LoaderCircle className="spin faint" aria-hidden="true" /> : null}
        </div>
      </div>
      <span className="field__hint">{hint}</span>
      {error ? (
        <span className="ap-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
