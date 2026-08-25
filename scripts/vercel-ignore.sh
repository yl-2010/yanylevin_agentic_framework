#!/usr/bin/env bash
exec git diff --quiet HEAD^ HEAD -- . \
  ':(exclude)education/you@example.com' \
  ':(exclude)fitness/you@example.com' \
  ':(exclude)ios'
