"use client";

import { Check, TriangleAlert, X } from "lucide-react";
import type { CSSProperties } from "react";
import type { ColorToken, Derived, PairResult, Report, Tokens } from "../../../../shared/theme";

/** Every text and colour pair that matters, with its contrast ratio, so a failure is explained rather than just blocked. */
export default function ContrastTable({ result }: { result: Derived & Report }) {
  const tokens: Tokens = result.tokens;
  return (
    <div className="ap-contrast">
      <table>
        <caption className="sr-only">Contrast of the main colour pairs</caption>
        <thead>
          <tr>
            <th scope="col">Pair</th>
            <th scope="col">Sample</th>
            <th scope="col" className="ap-num">
              Ratio
            </th>
            <th scope="col">Needs</th>
            <th scope="col">
              <span className="sr-only">Result</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {result.pairs.map((p: PairResult) => (
            <tr key={p.id} className={p.ok ? undefined : p.severity === "error" ? "is-error" : "is-warning"}>
              <th scope="row">{p.label}</th>
              <td>
                <span className="ap-sample" style={{ color: tokens[p.fg as ColorToken], background: tokens[p.bg as ColorToken] } as CSSProperties}>
                  Aa
                </span>
              </td>
              <td className="ap-num">{p.ratio.toFixed(1)}:1</td>
              <td>{p.min}:1</td>
              <td>
                {p.ok ? (
                  <Check className="ap-ok" aria-label="Passes" />
                ) : p.severity === "error" ? (
                  <X className="ap-bad" aria-label="Fails, cannot be saved" />
                ) : (
                  <TriangleAlert className="ap-warn" aria-label="Below the recommended level" />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
