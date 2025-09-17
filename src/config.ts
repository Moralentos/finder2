export class Config {
  static adminId: number = 989759353; // Замените на ваш Telegram ID
  static maxUserRequestsPerDay: number = 7; // Лимит запросов/день для обычных пользователей

  static setMaxUserRequestsPerDay(count: number): void {
    Config.maxUserRequestsPerDay = count;
  }
}
