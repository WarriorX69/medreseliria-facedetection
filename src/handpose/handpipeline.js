/**
 * @license
 * Copyright 2020 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

const tf = require('@tensorflow/tfjs');
const box = require('./box');
const util = require('./util');

const UPDATE_REGION_OF_INTEREST_IOU_THRESHOLD = 0.8;
const PALM_BOX_SHIFT_VECTOR = [0, -0.4];
const PALM_BOX_ENLARGE_FACTOR = 3;
const HAND_BOX_SHIFT_VECTOR = [0, -0.1]; // move detected hand box by x,y to ease landmark detection
const HAND_BOX_ENLARGE_FACTOR = 1.65; // increased from model default 1.65;
const PALM_LANDMARK_IDS = [0, 5, 9, 13, 17, 1, 2];
const PALM_LANDMARKS_INDEX_OF_PALM_BASE = 0;
const PALM_LANDMARKS_INDEX_OF_MIDDLE_FINGER_BASE = 2;

class HandPipeline {
  constructor(boundingBoxDetector, meshDetector, inputSize) {
    this.boundingBoxDetector = boundingBoxDetector;
    this.meshDetector = meshDetector;
    this.inputSize = inputSize;
    this.regionsOfInterest = [];
    this.runsWithoutHandDetector = 0;
    this.skipFrames = 0;
    this.detectedHands = 0;
  }

  getBoxForPalmLandmarks(palmLandmarks, rotationMatrix) {
    const rotatedPalmLandmarks = palmLandmarks.map((coord) => {
      const homogeneousCoordinate = [...coord, 1];
      return util.rotatePoint(homogeneousCoordinate, rotationMatrix);
    });
    const boxAroundPalm = this.calculateLandmarksBoundingBox(rotatedPalmLandmarks);
    return box.enlargeBox(box.squarifyBox(box.shiftBox(boxAroundPalm, PALM_BOX_SHIFT_VECTOR)), PALM_BOX_ENLARGE_FACTOR);
  }

  getBoxForHandLandmarks(landmarks) {
    const boundingBox = this.calculateLandmarksBoundingBox(landmarks);
    const boxAroundHand = box.enlargeBox(box.squarifyBox(box.shiftBox(boundingBox, HAND_BOX_SHIFT_VECTOR)), HAND_BOX_ENLARGE_FACTOR);
    const palmLandmarks = [];
    for (let i = 0; i < PALM_LANDMARK_IDS.length; i++) {
      palmLandmarks.push(landmarks[PALM_LANDMARK_IDS[i]].slice(0, 2));
    }
    boxAroundHand.palmLandmarks = palmLandmarks;
    return boxAroundHand;
  }

  transformRawCoords(rawCoords, box2, angle, rotationMatrix) {
    const boxSize = box.getBoxSize(box2);
    const scaleFactor = [boxSize[0] / this.inputSize, boxSize[1] / this.inputSize];
    const coordsScaled = rawCoords.map((coord) => [
      scaleFactor[0] * (coord[0] - this.inputSize / 2),
      scaleFactor[1] * (coord[1] - this.inputSize / 2),
      coord[2],
    ]);
    const coordsRotationMatrix = util.buildRotationMatrix(angle, [0, 0]);
    const coordsRotated = coordsScaled.map((coord) => {
      const rotated = util.rotatePoint(coord, coordsRotationMatrix);
      return [...rotated, coord[2]];
    });
    const inverseRotationMatrix = util.invertTransformMatrix(rotationMatrix);
    const boxCenter = [...box.getBoxCenter(box2), 1];
    const originalBoxCenter = [
      util.dot(boxCenter, inverseRotationMatrix[0]),
      util.dot(boxCenter, inverseRotationMatrix[1]),
    ];
    return coordsRotated.map((coord) => [
      coord[0] + originalBoxCenter[0],
      coord[1] + originalBoxCenter[1],
      coord[2],
    ]);
  }

  async estimateHands(image, config) {
    this.skipFrames = config.skipFrames;
    // don't need box detection if we have sufficient number of boxes
    let useFreshBox = (this.detectedHands === 0) || (this.detectedHands !== this.regionsOfInterest.length);
    let boundingBoxPredictions;
    // but every skipFrames check if detect boxes number changed
    if (useFreshBox || this.runsWithoutHandDetector > this.skipFrames) boundingBoxPredictions = await this.boundingBoxDetector.estimateHandBounds(image, config);
    // if there are new boxes and number of boxes doesn't match use new boxes, but not if maxhands is fixed to 1
    if (config.maxHands > 1 && boundingBoxPredictions && boundingBoxPredictions.length > 0 && boundingBoxPredictions.length !== this.detectedHands) useFreshBox = true;
    if (useFreshBox) {
      this.regionsOfInterest = [];
      if (!boundingBoxPredictions || boundingBoxPredictions.length === 0) {
        image.dispose();
        this.detectedHands = 0;
        return null;
      }
      for (const boundingBoxPrediction of boundingBoxPredictions) {
        this.regionsOfInterest.push(boundingBoxPrediction);
      }
      this.runsWithoutHandDetector = 0;
    } else {
      this.runsWithoutHandDetector++;
    }
    const hands = [];
    for (const i in this.regionsOfInterest) {
      const currentBox = this.regionsOfInterest[i];
      if (!currentBox) continue;
      const angle = util.computeRotation(currentBox.palmLandmarks[PALM_LANDMARKS_INDEX_OF_PALM_BASE], currentBox.palmLandmarks[PALM_LANDMARKS_INDEX_OF_MIDDLE_FINGER_BASE]);
      const palmCenter = box.getBoxCenter(currentBox);
      const palmCenterNormalized = [palmCenter[0] / image.shape[2], palmCenter[1] / image.shape[1]];
      const rotatedImage = tf.image.rotateWithOffset(image, angle, 0, palmCenterNormalized);
      const rotationMatrix = util.buildRotationMatrix(-angle, palmCenter);
      const newBox = useFreshBox ? this.getBoxForPalmLandmarks(currentBox.palmLandmarks, rotationMatrix) : currentBox;
      const croppedInput = box.cutBoxFromImageAndResize(newBox, rotatedImage, [this.inputSize, this.inputSize]);
      const handImage = croppedInput.div(255);
      croppedInput.dispose();
      rotatedImage.dispose();
      const prediction = this.meshDetector.predict(handImage);
      const [confidence, keypoints] = prediction;
      handImage.dispose();
      const confidenceValue = confidence.dataSync()[0];
      confidence.dispose();
      if (confidenceValue >= config.minConfidence) {
        const keypointsReshaped = tf.reshape(keypoints, [-1, 3]);
        const rawCoords = keypointsReshaped.arraySync();
        keypoints.dispose();
        keypointsReshaped.dispose();
        const coords = this.transformRawCoords(rawCoords, newBox, angle, rotationMatrix);
        const nextBoundingBox = this.getBoxForHandLandmarks(coords);
        this.updateRegionsOfInterest(nextBoundingBox, i);
        const result = {
          landmarks: coords,
          handInViewConfidence: confidenceValue,
          boundingBox: {
            topLeft: nextBoundingBox.startPoint,
            bottomRight: nextBoundingBox.endPoint,
          },
        };
        hands.push(result);
      } else {
        /*
        const result = {
          handInViewConfidence: confidenceValue,
          boundingBox: {
            topLeft: currentBox.startPoint,
            bottomRight: currentBox.endPoint,
          },
        };
        hands.push(result);
        */
      }
      keypoints.dispose();
    }
    this.detectedHands = hands.length;
    return hands;
  }

  // eslint-disable-next-line class-methods-use-this
  calculateLandmarksBoundingBox(landmarks) {
    const xs = landmarks.map((d) => d[0]);
    const ys = landmarks.map((d) => d[1]);
    const startPoint = [Math.min(...xs), Math.min(...ys)];
    const endPoint = [Math.max(...xs), Math.max(...ys)];
    return { startPoint, endPoint };
  }

  updateRegionsOfInterest(newBox, i) {
    const previousBox = this.regionsOfInterest[i];
    let iou = 0;
    if (previousBox != null && previousBox.startPoint != null) {
      const [boxStartX, boxStartY] = newBox.startPoint;
      const [boxEndX, boxEndY] = newBox.endPoint;
      const [previousBoxStartX, previousBoxStartY] = previousBox.startPoint;
      const [previousBoxEndX, previousBoxEndY] = previousBox.endPoint;
      const xStartMax = Math.max(boxStartX, previousBoxStartX);
      const yStartMax = Math.max(boxStartY, previousBoxStartY);
      const xEndMin = Math.min(boxEndX, previousBoxEndX);
      const yEndMin = Math.min(boxEndY, previousBoxEndY);
      const intersection = (xEndMin - xStartMax) * (yEndMin - yStartMax);
      const boxArea = (boxEndX - boxStartX) * (boxEndY - boxStartY);
      const previousBoxArea = (previousBoxEndX - previousBoxStartX) * (previousBoxEndY - boxStartY);
      iou = intersection / (boxArea + previousBoxArea - intersection);
    }
    this.regionsOfInterest[i] = iou > UPDATE_REGION_OF_INTEREST_IOU_THRESHOLD ? previousBox : newBox;
  }
}

exports.HandPipeline = HandPipeline;
