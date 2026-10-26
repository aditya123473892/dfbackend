import { Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import { ApiLoggerMiddleware } from './api-logger.middleware';

describe('API request logging', () => {
  it('logs the original endpoint and final status without query credentials', () => {
    const log = jest.spyOn(Logger, 'log').mockImplementation(() => undefined);
    try {
      const response = Object.assign(new EventEmitter(), { statusCode: 400 });
      const next = jest.fn();
      new ApiLoggerMiddleware().use(
        {
          method: 'POST',
          path: '/',
          originalUrl: '/api/photos/confirm?token=private-secret',
        } as any,
        response as any,
        next,
      );
      expect(next).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
      response.emit('finish');
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/^API: POST \/api\/photos\/confirm 400 \d+ms$/),
      );
    } finally {
      log.mockRestore();
    }
  });
});
