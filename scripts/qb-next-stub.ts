// Harness-only stub for next/navigation — the builder calls useRouter() for
// Cancel's router.back(). Nothing in a static render needs a real router.
export const useRouter = () => ({
  back: () => {}, push: () => {}, replace: () => {}, refresh: () => {},
  prefetch: () => {}, forward: () => {},
})
export const useSearchParams = () => new URLSearchParams()
export const usePathname = () => '/dashboard/quotes/new'
