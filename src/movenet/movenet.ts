/**
 * EfficientPose Module
 */

import { log, join } from '../helpers';
import * as tf from '../../dist/tfjs.esm.js';
import { Body } from '../result';
import { GraphModel } from '../tfjs/types';

let model: GraphModel;

type Keypoints = { score: number, part: string, position: { x: number, y: number }, positionRaw: { x: number, y: number } };

const keypoints: Array<Keypoints> = [];
let box: [number, number, number, number] = [0, 0, 0, 0];
let boxRaw: [number, number, number, number] = [0, 0, 0, 0];
let score = 0;
let skipped = Number.MAX_SAFE_INTEGER;

const bodyParts = ['nose', 'leftEye', 'rightEye', 'leftEar', 'rightEar', 'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist', 'leftHip', 'rightHip', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle'];

export async function load(config) {
  if (!model) {
    // @ts-ignore type mismatch on GraphModel
    model = await tf.loadGraphModel(join(config.modelBasePath, config.body.modelPath));
    if (!model || !model['modelUrl']) log('load model failed:', config.body.modelPath);
    else if (config.debug) log('load model:', model['modelUrl']);
  } else if (config.debug) log('cached model:', model['modelUrl']);
  return model;
}

export async function predict(image, config): Promise<Body[]> {
  if ((skipped < config.body.skipFrames) && config.skipFrame && Object.keys(keypoints).length > 0) {
    skipped++;
    return [{ id: 0, score, box, boxRaw, keypoints }];
  }
  skipped = 0;
  return new Promise(async (resolve) => {
    const tensor = tf.tidy(() => {
      if (!model.inputs[0].shape) return null;
      const resize = tf.image.resizeBilinear(image, [model.inputs[0].shape[2], model.inputs[0].shape[1]], false);
      const cast = tf.cast(resize, 'int32');
      return cast;
    });

    let resT;
    if (config.body.enabled) resT = await model.predict(tensor);
    tensor.dispose();

    if (resT) {
      keypoints.length = 0;
      const res = resT.arraySync();
      tf.dispose(resT);
      const kpt = res[0][0];
      for (let id = 0; id < kpt.length; id++) {
        score = kpt[id][2];
        if (score > config.body.minConfidence) {
          keypoints.push({
            score: Math.round(100 * score) / 100,
            part: bodyParts[id],
            positionRaw: { // normalized to 0..1
              x: kpt[id][1],
              y: kpt[id][0],
            },
            position: { // normalized to input image size
              x: Math.round(image.shape[2] * kpt[id][1]),
              y: Math.round(image.shape[1] * kpt[id][0]),
            },
          });
        }
      }
    }
    score = keypoints.reduce((prev, curr) => (curr.score > prev ? curr.score : prev), 0);
    const x = keypoints.map((a) => a.position.x);
    const y = keypoints.map((a) => a.position.y);
    box = [
      Math.min(...x),
      Math.min(...y),
      Math.max(...x) - Math.min(...x),
      Math.max(...y) - Math.min(...y),
    ];
    const xRaw = keypoints.map((a) => a.positionRaw.x);
    const yRaw = keypoints.map((a) => a.positionRaw.y);
    boxRaw = [
      Math.min(...xRaw),
      Math.min(...yRaw),
      Math.max(...xRaw) - Math.min(...xRaw),
      Math.max(...yRaw) - Math.min(...yRaw),
    ];
    resolve([{ id: 0, score, box, boxRaw, keypoints }]);
  });
}