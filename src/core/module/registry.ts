import type { FeatureModule } from './types.js';

const modules: FeatureModule[] = [];

/** Register a feature module. Later registrations win on id collision. */
export function registerModule(module: FeatureModule): void {
  const at = modules.findIndex((m) => m.id === module.id);
  if (at >= 0) modules[at] = module;
  else modules.push(module);
}

/** All modules, in dashboard order. */
export function listModules(): FeatureModule[] {
  return [...modules].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

export function getModule(id: string): FeatureModule | undefined {
  return modules.find((m) => m.id === id);
}