# syntax=docker/dockerfile:1.7
#
# flexmydomain relay: strfry 1.1.3 (tag pinned, commit verified) plus our write
# policy compiled to a standalone binary.
#
# Build from the repo root (docker-compose.yml does this):
#   docker build -f services/relay/Dockerfile -t fmd-relay:1.1.3 .
#
# strfry is a C++20 compile. Give it 2 GB of memory, or build elsewhere and push.
# MAKE_JOBS trades speed for memory.

ARG STRFRY_TAG=1.1.3
ARG STRFRY_COMMIT=16c00df04e264f4d68db5e10a48127f015c7824b
# One version for both the oven/bun image and the baseline runtime below.
ARG BUN_VERSION=1.3.14

# Same packages and steps as strfry's ubuntu.Dockerfile, but a shallow fetch.
FROM ubuntu:jammy AS strfry
ARG STRFRY_TAG
ARG STRFRY_COMMIT
RUN apt-get update && apt-get install -y --no-install-recommends \
      git g++ make pkg-config libtool ca-certificates \
      libssl-dev zlib1g-dev liblmdb-dev libflatbuffers-dev libsecp256k1-dev libzstd-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
# Tags can move, commits can't, so refuse any other commit. The commit pins
# every submodule. Each is fetched shallow at its pin (about 11 MB instead of
# 42), and `make setup-golpe` then finds them in place and fetches nothing.
RUN git -c advice.detachedHead=false clone --quiet --branch "$STRFRY_TAG" --depth 1 https://github.com/hoytech/strfry.git . \
    && test "$(git rev-parse HEAD)" = "$STRFRY_COMMIT" \
    && git submodule update --init --depth 1 \
    && git -C golpe submodule update --init --depth 1 \
    && make setup-golpe
# Own layer after the download, so a failed or re-tuned compile doesn't refetch.
ARG MAKE_JOBS=2
RUN make -j"$MAKE_JOBS"
# Debug sections are most of the binary (154 MB). Symbols stay, so stack traces
# still name functions.
RUN strip --strip-debug strfry

# On x86-64 the policy is compiled against Bun's "baseline" runtime. The default
# one needs AVX2, which many VPS CPUs lack (older Xeons, KVM generic models).
# There the plugin dies with "Illegal instruction" and strfry refuses every write.
# Fetched from npm and checked against the registry's published sha512. oven/bun's
# amd64 image ships the same binary today, but nothing guarantees it.
FROM ubuntu:jammy AS bun-baseline
ARG TARGETARCH
ARG BUN_VERSION
ARG BUN_BASELINE_SHA512=abff0474e0b4c9413c14f7a8395abcfcfc3923dfed25a62651f3bfb83500444c7c2149ce247d5127903706316aadef29bc9a22640f40a2f3c9ab916734d8d2c4
RUN mkdir -p /out && if [ "$TARGETARCH" = "amd64" ]; then \
      apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
      && curl -fsSL -o /tmp/bun.tgz "https://registry.npmjs.org/@oven/bun-linux-x64-baseline/-/bun-linux-x64-baseline-${BUN_VERSION}.tgz" \
      && echo "${BUN_BASELINE_SHA512}  /tmp/bun.tgz" | sha512sum -c - \
      && tar -xzf /tmp/bun.tgz -C /tmp \
      && install -m 0755 /tmp/package/bin/bun /out/bun; \
    fi

FROM oven/bun:${BUN_VERSION} AS policy
WORKDIR /src
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY core core
COPY client client
COPY services/relay services/relay
COPY test/vectors/relay-policy.test.ts test/vectors/relay-policy.test.ts
COPY --from=bun-baseline /out /opt/bun-baseline
# Policy tests gate the image. One that refuses the site's events or accepts
# everything never ships.
RUN bun test test/vectors/relay-policy.test.ts \
    && if [ -x /opt/bun-baseline/bun ]; then \
         bun build --compile --minify --target=bun-linux-x64-baseline \
           --compile-executable-path=/opt/bun-baseline/bun \
           services/relay/write-policy.ts --outfile /out/fmd-write-policy; \
       else \
         bun build --compile --minify services/relay/write-policy.ts --outfile /out/fmd-write-policy; \
       fi \
    && echo '{"type":"new","event":{"id":"00","pubkey":"00","kind":1,"tags":[],"content":""},"sourceType":"Import"}' \
       | /out/fmd-write-policy | grep -q '"action":"reject"'

FROM ubuntu:jammy
RUN apt-get update && apt-get install -y --no-install-recommends \
      liblmdb0 libflatbuffers1 libsecp256k1-0 libb2-1 libzstd1 libssl3 zlib1g ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin strfry \
    && mkdir -p /app/strfry-db \
    && chown strfry /app/strfry-db
COPY --from=strfry /build/strfry /app/strfry
COPY --from=policy /out/fmd-write-policy /app/fmd-write-policy
COPY services/relay/strfry.conf /etc/strfry.conf
COPY --chmod=0755 services/relay/entrypoint.sh /app/entrypoint.sh
USER strfry
WORKDIR /app
VOLUME ["/app/strfry-db"]
EXPOSE 7777
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["relay"]
