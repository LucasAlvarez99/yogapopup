/**
 * Dinero entre la base (céntimos enteros) y PayPal (cadenas "12.34"). Nunca se usa float para cobrar:
 * 19,99 € se guarda como 1999 y viaja como "19.99".
 */

/** 1999 -> "19.99". Solo enteros positivos o cero. */
export function centsToValue(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error("cents must be a non-negative integer");
  const euros = Math.floor(cents / 100);
  const rest = cents % 100;
  return `${euros}.${String(rest).padStart(2, "0")}`;
}

/** "19.99" -> 1999. Estricto: rechaza notación científica, signos, miles y más de 2 decimales. Devuelve null si no es válido. */
export function valueToCents(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(value);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  return Number.isSafeInteger(cents) ? cents : null;
}
