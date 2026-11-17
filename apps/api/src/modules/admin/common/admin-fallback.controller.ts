import { Controller, Delete, Get, Patch, Post, Put } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ADMIN_ROUTE_SEGMENT } from '../../../common/auth/admin-route';
import { AppError } from '../../../common/exceptions/app-error';

// The admin prefix itself and everything under it.
const ANY_ADMIN_PATH = ['', '*'];

/**
 * Every `/api/v1/admin` path the router can match to no real admin route, for GET (and so HEAD),
 * POST, PUT, PATCH and DELETE (S2-1).
 *
 * Without this controller the router answered unknown paths with its own 404, and the admin
 * guards never saw them. Once an address had used up its anonymous 60/min budget, real routes
 * answered 429 and unknown ones 404, so the 429 itself revealed which routes exist.
 *
 * Matched here, an unknown path goes through the same two guards as a real session route:
 * - AdminCsrfGuard checks its shape;
 * - AdminGuard counts it against the same per-IP (or per-session) budget and refuses it.
 * It gets the same 404, or the same 429 once the budget is used up.
 *
 * No real route is shadowed: the router prefers every static and parametric path over the
 * wildcard. There is no @AdminRoles, so AdminGuard refuses the path for every role (fail
 * closed) and the handlers never run. They throw NOT_FOUND only as a last line.
 *
 * What this controller can NOT see goes to the router's not-found handler instead, and the admin
 * not-found hook (admin-not-found.hook.ts) gives it the same treatment (S2R-1): a parametric
 * route matched with an empty parameter (`/admin/orders//refund`: the router picks that route,
 * the adapter refuses `id: ""`), any other method, and targets the adapter cannot route.
 * OPTIONS is not routed at all: the CORS hook answers preflights first.
 */
@Controller(ADMIN_ROUTE_SEGMENT)
@SkipThrottle()
export class AdminFallbackController {
  @Get(ANY_ADMIN_PATH)
  get(): never {
    throw new AppError('NOT_FOUND');
  }

  @Post(ANY_ADMIN_PATH)
  post(): never {
    throw new AppError('NOT_FOUND');
  }

  @Put(ANY_ADMIN_PATH)
  put(): never {
    throw new AppError('NOT_FOUND');
  }

  @Patch(ANY_ADMIN_PATH)
  patch(): never {
    throw new AppError('NOT_FOUND');
  }

  @Delete(ANY_ADMIN_PATH)
  delete(): never {
    throw new AppError('NOT_FOUND');
  }
}
