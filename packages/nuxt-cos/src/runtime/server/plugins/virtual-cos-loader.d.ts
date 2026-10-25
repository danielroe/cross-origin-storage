declare module 'virtual:cos-loader' {
  /** Loader `<script>` body (IIFE + inlined manifest) injected at SSR time. */
  const scriptContent: string
  export default scriptContent
  /** Response headers every page that runs the loader must send. */
  export const headers: Record<string, string>
}
