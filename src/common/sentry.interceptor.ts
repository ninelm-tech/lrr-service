import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpException,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import * as Sentry from '@sentry/node';

/**
 * Global interceptor — captures every unhandled exception (excluding 4xx HTTP
 * errors, which are expected validation/auth failures) and sends it to Sentry.
 *
 * Register in AppModule as APP_INTERCEPTOR so it applies to every route.
 */
@Injectable()
export class SentryInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      catchError((err) => {
        // Don't track 4xx client errors — those are expected
        const isClientError =
          err instanceof HttpException && err.getStatus() < 500;

        if (!isClientError) {
          Sentry.captureException(err);
        }

        return throwError(() => err);
      }),
    );
  }
}
