/**
 * AdapterRegistry — stores CalendarAdapter instances keyed by id.
 *
 * Third-party plugins call `register()` to plug in their own adapters at
 * runtime. Built-in adapters are registered by `createCalendarEngine()`.
 */

import type { CalendarAdapter } from './types.js';
import { AdapterNotFoundError } from './errors.js';

export class AdapterRegistry {
  private adapters = new Map<string, CalendarAdapter>();

  register(adapter: CalendarAdapter): void {
    if (this.adapters.has(adapter.id)) {
      // Re-registration wins — this lets plugins override built-ins.
      this.adapters.set(adapter.id, adapter);
      return;
    }
    this.adapters.set(adapter.id, adapter);
  }

  unregister(id: string): boolean {
    return this.adapters.delete(id);
  }

  get(id: string): CalendarAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new AdapterNotFoundError(id);
    return a;
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  list(): CalendarAdapter[] {
    return Array.from(this.adapters.values());
  }

  ids(): string[] {
    return Array.from(this.adapters.keys());
  }
}
