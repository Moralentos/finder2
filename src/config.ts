export class Config {
  //Кол-во запросов за N секунд
  static userRequests: number = 10;
  static timeRequests: number = 10000; //ms

  static setUserRequests(count: number): void {
    Config.userRequests = count;
  }

  static setTimeRequests(count: number): void {
    Config.timeRequests = count;
  }
}
