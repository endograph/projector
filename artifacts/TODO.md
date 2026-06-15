# TODO

## Release notes

- Document the current resume model explicitly: callers should hydrate or provide
  the current instance snapshot separately from the durable frame log. The
  `createMachine({ frames })` option currently preserves historical frames for
  projection and work scheduling, but it does not replay instance mutation frames
  into `root` during construction.
