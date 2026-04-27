from flask import Blueprint, request, jsonify
from db import get_db_connection

sensor_bp = Blueprint('sensor', __name__)


@sensor_bp.route('/sensors', methods=['GET'])
def get_sensors():
    db = get_db_connection()
    cursor = db.cursor(dictionary=True)
    cursor.execute(
        '''
        SELECT sensor_id, sensor_type, status, transformer_id
        FROM sensor
        ORDER BY sensor_id ASC
        '''
    )
    data = cursor.fetchall()
    cursor.close()
    db.close()
    return jsonify(data)


@sensor_bp.route('/readings', methods=['GET'])
def get_readings():
    db = get_db_connection()
    cursor = db.cursor(dictionary=True)
    cursor.execute('SELECT * FROM sensor_reading')
    data = cursor.fetchall()
    cursor.close()
    db.close()
    return jsonify(data)


@sensor_bp.route('/add-reading', methods=['POST'])
def add_reading():
    data = request.get_json(silent=True) or {}
    sensor_id = data.get('sensor_id')
    temperature = data.get('temperature')
    voltage = data.get('voltage')
    load_value = data.get('load', data.get('load_value'))

    if sensor_id is None or temperature is None or voltage is None or load_value is None:
        return jsonify({'status': 'error', 'message': 'sensor_id, temperature, voltage and load are required'}), 400

    db = get_db_connection()
    cursor = db.cursor()
    query = """
    INSERT INTO sensor_reading(sensor_id, timestamp, temperature, voltage, load_value)
    VALUES (%s, NOW(), %s, %s, %s)
    """
    cursor.execute(query, (sensor_id, temperature, voltage, load_value))
    db.commit()
    cursor.close()
    db.close()
    return jsonify({'status': 'success', 'message': 'Reading added successfully'})
