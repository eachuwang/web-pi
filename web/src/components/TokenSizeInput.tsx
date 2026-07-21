// #7: a token-size input as a number box + two mutually-exclusive unit
// toggles (K / M). Lifts the raw token count to the parent.
//   128 + K  → 128_000 ;  1 + M → 1_000_000 ;  8192 + (both off) → 8192.
// The number is in the chosen unit; turning a unit off keeps the number as-is
// (so 128 K → unchecking K yields 128 raw tokens — intentional, the user typed
// 128 and we don't silently rescale).
import { useEffect, useRef, useState } from "react";

const K = 1000;
const M = 1_000_000;

// Pick the unit that divides `value` evenly, preferring the larger one.
function unitOf(value: number): "" | "K" | "M" {
  if (value > 0 && value % M === 0) return "M";
  if (value > 0 && value % K === 0) return "K";
  return "";
}
function numberPart(value: number, unit: "" | "K" | "M"): string {
  if (!value) return "";
  const div = unit === "M" ? M : unit === "K" ? K : 1;
  return String(value / div);
}

export function TokenSizeInput({
  value,
  onChange,
  placeholder = "tokens",
}: {
  value: number | undefined;
  onChange: (n: number) => void;
  placeholder?: string;
}) {
  const [unit, setUnit] = useState<"" | "K" | "M">(unitOf(value ?? 0));
  // The number is free-text so the user can type intermediate states ("12" then
  // "128"); we sync from `value` only when the parent's normalized form would
  // differ from what's in the box (e.g. on load or after save).
  const [num, setNum] = useState<string>(numberPart(value ?? 0, unitOf(value ?? 0)));
  const lastLifted = useRef<number>(value ?? 0);

  // Re-derive display when the parent pushes a new value (load, save, reset).
  useEffect(() => {
    const v = value ?? 0;
    if (v === lastLifted.current) return;
    const u = unitOf(v);
    setUnit(u);
    setNum(numberPart(v, u));
    lastLifted.current = v;
  }, [value]);

  function lift(nextNum: string, nextUnit: "" | "K" | "M") {
    setNum(nextNum);
    setUnit(nextUnit);
    const n = Number(nextNum);
    if (!nextNum || !Number.isFinite(n) || n <= 0) {
      onChange(0);
      lastLifted.current = 0;
      return;
    }
    const mult = nextUnit === "M" ? M : nextUnit === "K" ? K : 1;
    const raw = Math.round(n * mult);
    onChange(raw);
    lastLifted.current = raw;
  }

  return (
    <div className="ts-input">
      <input
        className="sd-input sd-num"
        type="number"
        min={1}
        value={num}
        placeholder={placeholder}
        onChange={(e) => lift(e.target.value, unit)}
      />
      <div className="ts-units">
        <button
          type="button"
          className={`ts-unit${unit === "K" ? " on" : ""}`}
          onClick={() => lift(num, unit === "K" ? "" : "K")}
          title="thousands"
        >
          K
        </button>
        <button
          type="button"
          className={`ts-unit${unit === "M" ? " on" : ""}`}
          onClick={() => lift(num, unit === "M" ? "" : "M")}
          title="millions"
        >
          M
        </button>
      </div>
    </div>
  );
}
