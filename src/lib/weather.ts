// ── Weather data layer (Open-Meteo) ─────────────────────────────────────────────
// Free, keyless daily forecast for the business base location, so the Weather
// Dashboard and Weather Impact analytics can flag rain risk without any env setup.
// Pure fetch + mapping; no scheduling logic here (that stays in the existing
// optimizer / Rain Delay Center).

export interface DayForecast {
  date: string            // yyyy-MM-dd
  precipProbability: number // 0..100, max for the day
  precipMm: number        // total precipitation
  windKph: number         // max wind gust/speed for the day (km/h)
  code: number            // WMO weather code
  tempMax: number | null
  tempMin: number | null
  label: string
  emoji: string
  rainy: boolean          // enough rain risk to consider moving outdoor work
  severe: boolean         // thunderstorm / heavy / snow — strong reschedule signal
}

// "Rainy enough to disrupt mowing" — tuned conservative so it flags real risk.
export const RAIN_PROB_THRESHOLD = 55
const RAIN_MM_THRESHOLD = 2
// Wind strong enough to make trimming / blowing / debris work unpleasant or unsafe.
export const WIND_KPH_THRESHOLD = 40

// ── Weather Impact Score (Green / Yellow / Red) ──────────────────────────────────
// One simple traffic-light verdict per day, from rain probability, rainfall amount,
// wind and severe-weather flags. RED = delay recommended, YELLOW = monitor, GREEN =
// good to work. The ONE place a day's "should I work?" colour is decided — the
// dashboard, the strip and the Weather Ops hub all read this so the signal is
// identical everywhere.
export type WeatherLevel = 'green' | 'yellow' | 'red'

export interface WeatherScore {
  level: WeatherLevel
  label: string          // 'Good' | 'Monitor' | 'Delay recommended'
  reason: string         // short plain-language why
}

export function weatherScore(f: DayForecast): WeatherScore {
  // Severe (thunderstorm / freezing rain / heavy snow) is always RED.
  if (f.severe) return { level: 'red', label: 'Delay recommended', reason: `${f.label} — unsafe for outdoor work` }
  // Heavy rain by probability AND/OR accumulation → RED.
  if (f.precipProbability >= 75 || f.precipMm >= 8) {
    return { level: 'red', label: 'Delay recommended', reason: `${f.precipProbability}% rain · ${f.precipMm}mm expected` }
  }
  // Moderate rain risk, meaningful accumulation, or high wind → YELLOW (monitor).
  if (f.precipProbability >= RAIN_PROB_THRESHOLD || f.precipMm >= RAIN_MM_THRESHOLD || f.windKph >= WIND_KPH_THRESHOLD) {
    const why = f.windKph >= WIND_KPH_THRESHOLD && f.precipProbability < RAIN_PROB_THRESHOLD
      ? `Windy — gusts to ${f.windKph} km/h`
      : `${f.precipProbability}% rain · ${f.precipMm}mm — keep an eye on it`
    return { level: 'yellow', label: 'Monitor', reason: why }
  }
  return { level: 'green', label: 'Good', reason: 'Clear enough to work' }
}

// WMO weather interpretation codes → label + emoji.
function interpret(code: number): { label: string; emoji: string; severe: boolean } {
  if (code === 0) return { label: 'Clear', emoji: '☀️', severe: false }
  if (code <= 2) return { label: 'Partly cloudy', emoji: '🌤️', severe: false }
  if (code === 3) return { label: 'Overcast', emoji: '☁️', severe: false }
  if (code <= 48) return { label: 'Fog', emoji: '🌫️', severe: false }
  if (code <= 55) return { label: 'Drizzle', emoji: '🌦️', severe: false }
  if (code <= 65) return { label: 'Rain', emoji: '🌧️', severe: code >= 65 }
  if (code <= 67) return { label: 'Freezing rain', emoji: '🌧️', severe: true }
  if (code <= 77) return { label: 'Snow', emoji: '🌨️', severe: true }
  if (code <= 82) return { label: 'Rain showers', emoji: '🌧️', severe: code >= 82 }
  if (code <= 86) return { label: 'Snow showers', emoji: '🌨️', severe: true }
  if (code <= 99) return { label: 'Thunderstorm', emoji: '⛈️', severe: true }
  return { label: 'Unknown', emoji: '❓', severe: false }
}

interface OpenMeteoDaily {
  time: string[]
  precipitation_probability_max?: (number | null)[]
  precipitation_sum?: (number | null)[]
  windspeed_10m_max?: (number | null)[]
  windgusts_10m_max?: (number | null)[]
  weathercode?: (number | null)[]
  temperature_2m_max?: (number | null)[]
  temperature_2m_min?: (number | null)[]
}

// ── Forecast cache ───────────────────────────────────────────────────────────
// The forecast is PUBLIC data keyed only by coordinate — no user rows, no RLS —
// so it is safe to share across callers and requests (nothing tenant-specific can
// leak through this key). That matters because loadWeatherImpact is called from
// four places and the dashboard + Schedule both mount WeatherStrip, so a single
// morning could fire the same Open-Meteo request several times over.
//
// Two layers:
//   • ttl      — a 10-minute result cache. Rain forecasts don't move minute to
//                minute, and Weather Ops decisions are made on the hour.
//   • inflight — concurrent callers share ONE request instead of racing (the
//                Schedule page mounts WeatherStrip AND calls the engine itself).
// Failures are never cached, so a blip can't stick for 10 minutes.
const FORECAST_TTL_MS = 10 * 60_000
const forecastCache = new Map<string, { at: number; data: DayForecast[] }>()
const forecastInflight = new Map<string, Promise<DayForecast[]>>()

// Coarse key: a few metres of GPS jitter is the same weather.
const forecastKey = (lat: number, lng: number, days: number) =>
  `${lat.toFixed(3)},${lng.toFixed(3)},${days}`

/** Drop cached forecasts (tests / an explicit refresh). */
export function clearForecastCache(): void {
  forecastCache.clear()
  forecastInflight.clear()
}

// Fetch the next `days` of daily forecast for a coordinate. Returns [] on any
// failure so the UI degrades gracefully (never throws into the page).
export async function fetchForecast(lat: number, lng: number, days = 7): Promise<DayForecast[]> {
  const key = forecastKey(lat, lng, days)
  const hit = forecastCache.get(key)
  if (hit && Date.now() - hit.at < FORECAST_TTL_MS) return hit.data
  const pending = forecastInflight.get(key)
  if (pending) return pending

  const run = fetchForecastUncached(lat, lng, days)
    .then(data => {
      // Only cache a real answer — [] means the request failed or the API had
      // nothing, and caching that would blind Weather Ops for 10 minutes.
      if (data.length) forecastCache.set(key, { at: Date.now(), data })
      return data
    })
    .finally(() => { forecastInflight.delete(key) })

  forecastInflight.set(key, run)
  return run
}

// A third party must never be able to hang EdgeQuote. The dashboard renders this
// on the server, so an Open-Meteo stall would otherwise hold the whole morning
// view hostage with no way to bail. Time it out and degrade to "no forecast" —
// the strip and Weather Ops both already handle an empty forecast.
const FORECAST_TIMEOUT_MS = 2_500

async function fetchForecastUncached(lat: number, lng: number, days: number): Promise<DayForecast[]> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), FORECAST_TIMEOUT_MS)
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}`
      + `&daily=precipitation_probability_max,precipitation_sum,windspeed_10m_max,windgusts_10m_max,weathercode,temperature_2m_max,temperature_2m_min`
      + `&timezone=auto&forecast_days=${days}`
    const res = await fetch(url, { signal: ctl.signal })
    if (!res.ok) return []
    const json = await res.json() as { daily?: OpenMeteoDaily }
    const d = json.daily
    if (!d?.time) return []
    return d.time.map((date, i) => {
      const code = Number(d.weathercode?.[i] ?? 0)
      const prob = Number(d.precipitation_probability_max?.[i] ?? 0)
      const mm = Number(d.precipitation_sum?.[i] ?? 0)
      // Prefer gusts (what actually disrupts trimming/blowing) when available.
      const wind = Number(d.windgusts_10m_max?.[i] ?? d.windspeed_10m_max?.[i] ?? 0)
      const info = interpret(code)
      return {
        date,
        precipProbability: Math.round(prob),
        precipMm: Math.round(mm * 10) / 10,
        windKph: Math.round(wind),
        code,
        tempMax: d.temperature_2m_max?.[i] != null ? Math.round(Number(d.temperature_2m_max[i])) : null,
        tempMin: d.temperature_2m_min?.[i] != null ? Math.round(Number(d.temperature_2m_min[i])) : null,
        label: info.label,
        emoji: info.emoji,
        rainy: prob >= RAIN_PROB_THRESHOLD || mm >= RAIN_MM_THRESHOLD || info.severe,
        severe: info.severe,
      }
    })
  } catch {
    // Includes the abort above — a slow forecast is a missing forecast, not an error.
    return []
  } finally {
    clearTimeout(timer)
  }
}