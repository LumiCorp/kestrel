export interface WeatherCurrentProviderInput {
  toolName: string;
  latitude: number;
  longitude: number;
  signal?: AbortSignal | undefined;
}

export interface WeatherForecastProviderInput
  extends WeatherCurrentProviderInput {
  days: number;
  timezone: string;
}

export interface NormalizedWeatherCurrent {
  source: string;
  latitude: number;
  longitude: number;
  temperatureC: number;
  apparentTemperatureC?: number | undefined;
  humidityPct?: number | undefined;
  weatherCode?: number | undefined;
  condition?: string | undefined;
  windSpeedKph?: number | undefined;
  observedAt: string;
}

export interface NormalizedWeatherForecast {
  source: string;
  latitude: number;
  longitude: number;
  timezone: string;
  current: Record<string, unknown>;
  hourly: Record<string, unknown>;
  daily: Record<string, unknown>;
}

export interface WeatherProviderAdapter {
  current(input: WeatherCurrentProviderInput): Promise<NormalizedWeatherCurrent>;
  forecast(
    input: WeatherForecastProviderInput,
  ): Promise<NormalizedWeatherForecast>;
}
