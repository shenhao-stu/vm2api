# Overlay the exact, reviewed vm2api production image. This never replaces its runtime.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY package.json package-lock.json VERSION /opt/vm2api/
COPY src/ /opt/vm2api/src/
COPY scripts/ /opt/vm2api/scripts/
COPY integrations/reclaude/ /opt/vm2api/integrations/reclaude/
COPY test/ /opt/vm2api/test/
RUN chmod -R a+rX /opt/vm2api/src /opt/vm2api/scripts /opt/vm2api/integrations /opt/vm2api/test \
    && chmod a+r /opt/vm2api/package.json /opt/vm2api/package-lock.json /opt/vm2api/VERSION
