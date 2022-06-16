#!/bin/bash

npm start &

dockerd-entrypoint.sh

wait
