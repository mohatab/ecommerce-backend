/**
 * The job names, which are also the primary keys of `maintenance_leases`.
 *
 * The migration seeds exactly these three strings, so a value added here
 * without a matching migration makes `acquire()` return `'missing'` rather
 * than silently creating a row — see `MaintenanceLeaseService.acquire`.
 */
export enum MaintenanceJobName {
  ORDER_EXPIRY = 'order-expiry',
  MAINTENANCE_PURGE = 'maintenance-purge',
  PAYMENT_RECONCILIATION = 'payment-reconciliation',
}
