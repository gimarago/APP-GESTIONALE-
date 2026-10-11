export function assertSimulation() {
  if ((process.env.APP_ENV || 'test') !== 'test' ||
      (process.env.SDI_MODE || 'simulator') !== 'simulator') {
    throw new Error('PRODUCTION_DISABLED: disponibile soltanto il simulatore in ambiente test');
  }
}
