# WeatherBet — bot and dashboard share a single image.
# Which service runs is chosen at `docker run` time via the command.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# tzdata is pulled in via pip so zoneinfo resolves every IANA zone on the
# slim base image (Debian slim ships without /usr/share/zoneinfo entries
# for many cities).
COPY requirements.txt ./
RUN pip install -r requirements.txt tzdata

# Source, config, and the empty data skeleton.
COPY bot_v2.py bot_v1.py dashboard.py config.json ./
COPY static ./static
COPY templates ./templates
COPY data ./data

# Dashboard listens on 8050 by default.
EXPOSE 8050

# The docker-compose file overrides `command` for each service. This
# default is only hit if someone runs the image with no command.
CMD ["python", "-u", "bot_v2.py"]
