export type Status = {
  refreshing: boolean;
  lastAttempt?: string;
  metadataUpdatedAt?: string;
  metadataModels: number;
  error?: string;
  warning?: string;
  providers: Record<string, { models: number; updatedAt?: string; cached: boolean; missingMetadata: string[]; error?: string }>;
};

export function formatStatus(status: Status): string {
  const lines = ["Каталог Selectel:"];
  for (const [id, provider] of Object.entries(status.providers)) {
    lines.push(`- ${id}: ${provider.models} моделей${provider.updatedAt ? `; обновлено ${formatTime(provider.updatedAt)}` : "; используется конфигурация"}${provider.cached ? "; сохранённый кэш" : ""}`);
    if (provider.missingMetadata.length) lines.push(`  Без метаданных OpenRouter: ${provider.missingMetadata.join(", ")}. Прежние варианты сохранены.`);
  }
  if (status.metadataUpdatedAt) lines.push(`Метаданные models.dev проверены ${formatTime(status.metadataUpdatedAt)}.`);
  if (status.refreshing) lines.push("Обновление выполняется.");
  if (status.warning) lines.push(`Предупреждение: ${status.warning}`);
  if (status.error) lines.push(`Ошибка: ${status.error}`);
  return lines.join("\n");
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
}
