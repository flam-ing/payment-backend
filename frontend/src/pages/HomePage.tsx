import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Copy, Locale } from "../lib/content";
import { createPayPalCheckout } from "../lib/payment-client";

type HomePageProps = {
  copy: Copy;
  locale: Locale;
  apiBaseUrl: string;
};

function symbolFor(currency: string) {
  return currency === "KRW" ? "₩" : "$";
}

function formatPreset(locale: Locale, currency: string, amount: number) {
  const formatted = amount.toLocaleString(locale === "ko" ? "ko-KR" : "en-US");
  return `${symbolFor(currency)}${formatted}`;
}

export function HomePage({ copy, locale, apiBaseUrl }: HomePageProps) {
  const navigate = useNavigate();
  const [amountInput, setAmountInput] = useState(String(copy.amountPresets[1]));
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amount = useMemo(() => {
    const digits = amountInput.replace(/[^0-9]/g, "");
    return digits.length > 0 ? Number(digits) : 0;
  }, [amountInput]);

  const amountInputWidth = useMemo(() => `${Math.max(amountInput.length + 0.6, 4.5)}ch`, [amountInput.length]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const payload = {
        amount,
        currency: copy.currency,
        note: note.trim(),
        locale,
        region: locale === "ko" ? "domestic" : "international"
      } as const;

      const session = await createPayPalCheckout(apiBaseUrl, payload);

      if (session.redirectUrl.startsWith("/")) {
        navigate(session.redirectUrl);
        return;
      }

      window.location.assign(session.redirectUrl);
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : "Unexpected checkout error.";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <main className="flex-1 flex flex-col items-center justify-center px-8 py-12 max-w-md mx-auto w-full">
        <div className="w-full mb-12 flex flex-col items-center">
          <div className="relative mb-6">
            <div className="absolute inset-0 signature-gradient rounded-full blur-2xl opacity-10 transform scale-150" />
            <div className="relative w-32 h-32 rounded-full overflow-hidden border border-primary/10 shadow-[0_20px_50px_rgba(24,73,229,0.12)]">
              <img
                alt="Minwoo Kim"
                className="h-full w-full object-cover object-[center_16%]"
                src="/minwoo-profile.jpg"
              />
            </div>
          </div>
          <h2 className="text-3xl font-headline font-extrabold tracking-tight text-on-surface mb-1">Pay to Minwoo</h2>
        </div>

        <form className="w-full" onSubmit={handleSubmit}>
          <div className="w-full bg-surface-container-lowest p-8 rounded-[2rem] shadow-[0_8px_32px_rgba(15,23,42,0.04)] mb-8 flex flex-col items-center">
            <label className="text-on-surface-variant font-label text-xs uppercase tracking-[0.2em] mb-4">{copy.enterAmount}</label>
            <div className="flex items-baseline justify-center gap-2 max-w-full overflow-visible">
              <span className="shrink-0 text-4xl font-headline font-bold text-primary">{symbolFor(copy.currency)}</span>
              <input
                className="min-w-0 max-w-full bg-transparent border-none p-0 text-6xl leading-none font-headline font-black text-on-background focus:ring-0 text-center selection:bg-primary-container/30"
                inputMode="numeric"
                style={{ width: amountInputWidth }}
                type="text"
                value={amountInput}
                onChange={(event) => setAmountInput(event.target.value.replace(/[^0-9]/g, ""))}
              />
            </div>
            <div className="flex gap-3 mt-8 flex-wrap justify-center">
              {copy.amountPresets.map((preset) => (
                <button
                  key={preset}
                  className={preset === amount ? "px-5 py-2 rounded-full bg-primary-container text-primary font-body text-sm font-semibold transition-all active:scale-95" : "px-5 py-2 rounded-full bg-surface-container text-on-surface font-body text-sm font-semibold transition-all active:scale-95 hover:bg-surface-container-high"}
                  type="button"
                  onClick={() => setAmountInput(String(preset))}
                >
                  {formatPreset(locale, copy.currency, preset)}
                </button>
              ))}
            </div>
          </div>

          <div className="w-full px-4 mb-12">
            <div className="flex items-center gap-3 bg-surface-container-low rounded-xl px-4 py-3 group focus-within:bg-surface-container-high transition-colors">
              <span className="material-symbols-outlined text-outline">edit_note</span>
              <input
                className="bg-transparent border-none p-0 focus:ring-0 text-on-surface-variant font-body text-sm w-full placeholder:text-outline"
                placeholder={copy.notePlaceholder}
                type="text"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
          </div>

          {error ? (
            <div className="w-full mb-6 rounded-[1.5rem] bg-error-container/20 px-5 py-4 text-sm text-on-error-container border border-error/10">
              {error}
            </div>
          ) : null}

          <div className="w-full">
            <button
              className="w-full signature-gradient text-on-primary font-headline font-bold text-lg py-5 rounded-full shadow-lg shadow-primary/20 transition-all duration-300 active:scale-[0.98] hover:shadow-xl hover:shadow-primary/30 disabled:opacity-60"
              disabled={submitting || amount <= 0}
              type="submit"
            >
              {submitting ? "Processing..." : copy.primaryAction}
            </button>
          </div>
        </form>
      </main>
      <div className="fixed top-0 left-0 w-full h-px bg-slate-200 z-[60]" />
    </>
  );
}
