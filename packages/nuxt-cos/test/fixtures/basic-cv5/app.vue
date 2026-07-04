<template>
  <div class="counter">
    <p>count: {{ count }}</p>
    <button @click="count++">
      increment
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

useHead({
  title: 'cos fixture',
})

const count = ref(0)
</script>

<style scoped>
.counter {
  color: rebeccapurple;
}
</style>
