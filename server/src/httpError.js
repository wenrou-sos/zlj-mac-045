// 带 HTTP 状态码的业务错误，错误中间件按 status 返回
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const httpError = (status, message) => new HttpError(status, message);
