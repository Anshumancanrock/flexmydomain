# syntax=docker/dockerfile:1.7
#
# The flexmydomain relay: strfry 1.1.3, pinned by tag and verified by commit,
# plus this repository's write policy compiled to a standalone binary.
#
# Build from the repository root (docker-compose.yml does this for you):
#   docker build -f services/relay/Dockerfile -t fmd-relay:1.1.3 .
#
# Building strfry is a C++20 compile. Give the build 2 GB of memory, or build
# the image elsewhere and push it; MAKE_JOBS trades speed for memory.

ARG STRFRY_TAG=1.1.3
ARG STRFRY_COMMIT=16c00df04e264f4d68db5e10a48127f015c7824b
# The oven/bun image and the baseline runtime below, always the same version.
ARG BUN_VERSION=1.3.14

# ---------------------------------------------------------------- strfry ---
# The same packages and build steps as strfry's own ubuntu.Dockerfile, with the
# sources fetched without their history.
FROM ubuntu:jammy AS strfry
ARG STRFRY_TAG
ARG STRFRY_COMMIT
RUN apt-get update && apt-get install -y --no-install-recommends \
      git g++ make pkg-config libtool ca-certificates \
      libssl-dev zlib1g-dev liblmdb-dev libflatbuffers-dev libsecp256k1-dev libzstd-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
# A tag can be moved; the commit cannot. Refuse to build anything else. The
# commit pins every submodule, and each is fetched at its pinned commit
# without its history: about 11 MB instead of 42. `make setup-golpe` then
# finds them all in place and fetches nothing.
RUN git -c advice.detachedHead=false clone --quiet --branch "$STRFRY_TAG" --depth 1 https://github.com/hoytech/strfry.git . \
    && test "$(git rev-parse HEAD)" = "$STRFRY_COMMIT" \
    && git submodule update --init --depth 1 \
    && git -C golpe submodule update --init --depth 1 \
    && make setup-golpe
# Its own layer, after the download, so a failed or re-tuned compile does not
# fetch the sources again.
ARG MAKE_JOBS=2
RUN make -j"$MAKE_JOBS"
# Debug sections are most of the binary (154 MB of it). The symbol table
# stays, so a crash's stack trace still names its functions.
RUN strip --strip-debug strfry

# -------------------------------------------------------- bun baseline ---
# On x86-64 the write policy is compiled against Bun's "baseline" runtime.
# The default runtime needs AVX2, and many VPS CPUs (older Xeons, or KVM's
# generic CPU models) do not have it: there the plugin would die with "Illegal
# instruction" and strfry would refuse every write. The runtime comes from the
# npm registry, checked against the sha512 that registry publishes for it.
# oven/bun's amd64 image currently ships the same binary, but nothing
# guarantees that it will keep doing so.
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

# --------------------------------------------------------------- policy ---
FROM oven/bun:${BUN_VERSION} AS policy
WORKDIR /src
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY core core
COPY client client
COPY services/relay services/relay
COPY test/vectors/relay-policy.test.ts test/vectors/relay-policy.test.ts
COPY --from=bun-baseline /out /opt/bun-baseline
# The policy's own tests gate the image: a policy that refuses the site's
# events, or accepts everything, never ships.
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

# -------------------------------------------------------------- runtime ---
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
