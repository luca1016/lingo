import type { Steps } from "ts-fsrs";
import { fromUtcIso } from "../time";
import { SETTINGS_ID } from "./constants";
import type { Settings } from "./types";

interface SettingsRow {
  timezone: string;
  new_cards_per_day: number;
  learning_steps: string;
  relearning_steps: string;
  request_retention: number;
  maximum_interval: number;
  enable_fuzz: number;
  enable_short_term: number;
  fsrs_w: string;
  params_version: number;
  updated_at: string;
}

/** 設定を読む(migration が 1 行入れているので必ずある)。 */
export async function getSettings(db: D1Database): Promise<Settings> {
  const row = await db
    .prepare(
      `SELECT timezone, new_cards_per_day, learning_steps, relearning_steps, request_retention,
              maximum_interval, enable_fuzz, enable_short_term, fsrs_w, params_version, updated_at
       FROM settings WHERE id = ?`,
    )
    .bind(SETTINGS_ID)
    .first<SettingsRow>();
  if (!row) throw new Error("settings row is missing");

  return {
    timezone: row.timezone,
    newCardsPerDay: row.new_cards_per_day,
    fsrs: {
      request_retention: row.request_retention,
      maximum_interval: row.maximum_interval,
      w: JSON.parse(row.fsrs_w) as number[],
      enable_fuzz: row.enable_fuzz !== 0,
      enable_short_term: row.enable_short_term !== 0,
      learning_steps: JSON.parse(row.learning_steps) as Steps,
      relearning_steps: JSON.parse(row.relearning_steps) as Steps,
    },
    paramsVersion: row.params_version,
    updatedAt: fromUtcIso(row.updated_at),
  };
}
