#!/usr/bin/env bash
exec git diff --quiet HEAD^ HEAD -- . \
  ':(exclude)home/you@example.com' \
  ':(exclude)fitness/you@example.com' \
  ':(exclude)tmp' \
  ':(exclude)ios'
