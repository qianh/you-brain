/**
 * Shared `Intl.DateTimeFormat` instances. Building one costs far more than formatting with
 * it, and day bucketing builds them per event: a flush checking 19k events against a day
 * held the daemon's thread for five seconds. Formatters are immutable, so one per locale
 * and options is enough. An invalid time zone still throws on first use, as before.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

export function dateTimeFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}\u0000${JSON.stringify(options)}`;
  let formatter = formatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, formatter);
  }
  return formatter;
}
