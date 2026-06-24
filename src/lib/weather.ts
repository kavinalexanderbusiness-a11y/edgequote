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

// Fetch the next `days` of daily forecast for a coordinate. Returns [] on any
// failure so the UI degrades gracefully (never throws into the page).
export async function fetchForecast(lat: number, lng: number, days = 7): Promise<DayForecast[]> {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}`
      + `&daily=precipitation_probability_max,precipitation_sum,windspeed_10m_max,windgusts_10m_max,weathercode,temperature_2m_max,temperature_2m_min`
      + `&timezone=auto&forecast_days=${days}`
    const res = await fetch(url)
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
    return []
  }
}