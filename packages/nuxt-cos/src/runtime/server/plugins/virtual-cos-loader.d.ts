declare module 'virtual:cos-loader' {
  /** Loader `<script>` body (IIFE + inlined manifest) injected at SSR time. */
  const scriptContent: string
  export default scriptContent
}
