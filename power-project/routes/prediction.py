from math import exp
from flask import Blueprint, jsonify, request
from db import get_db_connection

prediction_bp = Blueprint('prediction', __name__)



def _sigmoid(value):
    if value < -60:
        return 0.0
    if value > 60:
        return 1.0
    return 1.0 / (1.0 + exp(-value))



def _build_training_dataset(cursor):
    cursor.execute(
        '''
        SELECT
            sr.sensor_id,
            sr.temperature,
            sr.voltage,
            sr.load_value,
            s.transformer_id,
            t.capacity,
            CASE
                WHEN EXISTS (
                    SELECT 1
                    FROM power_outage po
                    WHERE po.transformer_id = s.transformer_id
                      AND po.start_time >= sr.timestamp
                      AND po.start_time <= DATE_ADD(sr.timestamp, INTERVAL 2 HOUR)
                ) THEN 1 ELSE 0
            END AS label
        FROM sensor_reading sr
        JOIN sensor s ON s.sensor_id = sr.sensor_id
        LEFT JOIN transformer t ON t.transformer_id = s.transformer_id
        ORDER BY sr.reading_id ASC
        '''
    )
    rows = cursor.fetchall()

    dataset = []
    for row in rows:
        temp = float(row[1] or 0)
        voltage = float(row[2] or 0)
        load_value = float(row[3] or 0)
        capacity = float(row[5] or 0)
        load_ratio = (load_value / capacity) if capacity > 0 else 0.0

        dataset.append(
            {
                'features': [temp / 120.0, voltage / 300.0, load_ratio],
                'label': int(row[6])
            }
        )

    return dataset



def _train_logistic_regression(dataset):
    labels = [item['label'] for item in dataset]
    if len(dataset) < 4 or len(set(labels)) < 2:
        return None

    weights = [0.0, 0.0, 0.0]
    bias = 0.0
    learning_rate = 0.4
    epochs = 800

    for _ in range(epochs):
        dw = [0.0, 0.0, 0.0]
        db = 0.0

        for item in dataset:
            x = item['features']
            y = item['label']
            pred = _sigmoid(weights[0] * x[0] + weights[1] * x[1] + weights[2] * x[2] + bias)
            error = pred - y

            dw[0] += error * x[0]
            dw[1] += error * x[1]
            dw[2] += error * x[2]
            db += error

        total = float(len(dataset))
        weights[0] -= learning_rate * dw[0] / total
        weights[1] -= learning_rate * dw[1] / total
        weights[2] -= learning_rate * dw[2] / total
        bias -= learning_rate * db / total

    return {'weights': weights, 'bias': bias}



def _fallback_score(temp, voltage, load_ratio):
    # Rule-guided score used only when historical classes are insufficient for stable training.
    score = 0.0

    if temp > 90:
        score += 0.5
    elif temp > 80:
        score += 0.25

    if voltage < 215 or voltage > 245:
        score += 0.2

    if load_ratio >= 0.95:
        score += 0.25
    elif load_ratio >= 0.80:
        score += 0.15

    return min(score, 0.99)



def _risk_level(score):
    if score >= 0.7:
        return 'HIGH'
    if score >= 0.4:
        return 'MEDIUM'
    return 'LOW'


@prediction_bp.route('/predict-outage-risk', methods=['POST'])
def predict_outage_risk():
    data = request.get_json(silent=True) or {}

    sensor_id = data.get('sensor_id')
    temperature = data.get('temperature')
    voltage = data.get('voltage')
    load_value = data.get('load', data.get('load_value'))

    if sensor_id is None or temperature is None or voltage is None or load_value is None:
        return jsonify({'status': 'error', 'message': 'sensor_id, temperature, voltage and load are required'}), 400

    try:
        sensor_id = int(sensor_id)
        temperature = float(temperature)
        voltage = float(voltage)
        load_value = float(load_value)
    except (TypeError, ValueError):
        return jsonify({'status': 'error', 'message': 'Invalid numeric values'}), 400

    db = get_db_connection()
    cursor = db.cursor()

    cursor.execute(
        '''
        SELECT s.transformer_id, t.capacity
        FROM sensor s
        LEFT JOIN transformer t ON t.transformer_id = s.transformer_id
        WHERE s.sensor_id = %s
        LIMIT 1
        ''',
        (sensor_id,)
    )
    mapping = cursor.fetchone()

    if mapping is None:
        cursor.close()
        db.close()
        return jsonify({'status': 'error', 'message': 'Invalid sensor_id'}), 400

    transformer_id = int(mapping[0])
    capacity = float(mapping[1] or 0)
    load_ratio = (load_value / capacity) if capacity > 0 else 0.0

    dataset = _build_training_dataset(cursor)
    model = _train_logistic_regression(dataset)

    x = [temperature / 120.0, voltage / 300.0, load_ratio]

    if model:
        logistic_score = _sigmoid(
            model['weights'][0] * x[0] +
            model['weights'][1] * x[1] +
            model['weights'][2] * x[2] +
            model['bias']
        )
        rule_score = _fallback_score(temperature, voltage, load_ratio)
        score = max(logistic_score, rule_score)
        model_type = 'hybrid_logistic_rule'
    else:
        score = _fallback_score(temperature, voltage, load_ratio)
        model_type = 'fallback_scoring'

    risk = _risk_level(score)

    cursor.close()
    db.close()

    return jsonify(
        {
            'status': 'success',
            'model_type': model_type,
            'training_samples': len(dataset),
            'transformer_id': transformer_id,
            'risk_score': round(score, 4),
            'risk_percent': round(score * 100, 2),
            'risk_level': risk
        }
    )
