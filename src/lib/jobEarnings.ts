export interface EarningsInput {
  customerTotal: number; salesTax: number; ownerMinutes: number; helperMinutes: number
  helperPay: number; fuel: number; paymentFees: number; otherCosts: number
}
export function calculateJobEarnings(v: EarningsInput) {
  if (Object.values(v).some(n => !Number.isFinite(n) || n < 0) || v.ownerMinutes <= 0 || v.salesTax > v.customerTotal) {
    throw new Error('Enter valid amounts, at least one minute of your time, and sales tax no greater than the customer total.')
  }
  const cents = (n: number) => Math.round((n + Number.EPSILON) * 100)
  const revenue = (cents(v.customerTotal) - cents(v.salesTax)) / 100
  const costs = [v.helperPay, v.fuel, v.paymentFees, v.otherCosts].reduce((sum, n) => sum + cents(n), 0) / 100
  const labourHours = (v.ownerMinutes + v.helperMinutes) / 60
  const remaining = (cents(revenue) - cents(costs)) / 100
  return { revenue, costs, labourHours, remaining, revenuePerManHour: revenue / labourHours, remainingPerOwnerHour: remaining / (v.ownerMinutes / 60) }
}
export function allocateMonthlyRound(customerTotal: number, rounds: number) {
  if (!Number.isFinite(customerTotal) || customerTotal < 0 || !Number.isInteger(rounds) || rounds < 1) throw new Error('Enter a monthly amount and at least one whole round.')
  return customerTotal / rounds
}
