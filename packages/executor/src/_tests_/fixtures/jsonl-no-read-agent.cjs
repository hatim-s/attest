// Deliberately never reads stdin so hostile tests can exercise pipe backpressure cancellation.
setInterval(() => {}, 1_000);
