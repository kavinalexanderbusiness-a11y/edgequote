import assert from 'node:assert/strict'
import { calculateJobEarnings, allocateMonthlyRound } from '../src/lib/jobEarnings'
const base = { customerTotal: 225, salesTax: 0, ownerMinutes: 120, helperMinutes: 0, helperPay: 0, fuel: 15, paymentFees: 0, otherCosts: 10 }
assert.equal(calculateJobEarnings(base).revenuePerManHour,112.5)
assert.equal(calculateJobEarnings(base).remainingPerOwnerHour,100)
const crew=calculateJobEarnings({...base, helperMinutes:120, helperPay:50})
assert.equal(crew.labourHours,4);assert.equal(crew.revenuePerManHour,56.25);assert.equal(crew.remaining,150)
assert.equal(calculateJobEarnings({...base,customerTotal:105,salesTax:5}).revenue,100)
assert.equal(calculateJobEarnings({...base,customerTotal:0}).remaining,-25)
assert.throws(()=>calculateJobEarnings({...base,ownerMinutes:0}))
assert.throws(()=>calculateJobEarnings({...base,salesTax:226}))
assert.throws(()=>calculateJobEarnings({...base,fuel:NaN}))
assert.throws(()=>calculateJobEarnings({...base,helperPay:-1}))
assert.equal(allocateMonthlyRound(797,8),99.625)
assert.throws(()=>allocateMonthlyRound(797,0));assert.throws(()=>allocateMonthlyRound(797,1.5))
assert.equal(calculateJobEarnings({...base,customerTotal:.3,salesTax:.1,fuel:0,otherCosts:0}).remaining,.2)
console.log('Job earnings: solo, crew, tax, losses, cents and invalid inputs passed')
