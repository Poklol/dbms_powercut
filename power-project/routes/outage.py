from flask import Blueprint, jsonify, request
from db import get_db_connection

outage_bp = Blueprint('outage', __name__)


@outage_bp.route('/outages', methods=['GET'])
def get_outages():
    db = get_db_connection()
    cursor = db.cursor(dictionary=True)
    cursor.execute('SELECT * FROM power_outage')
    data = cursor.fetchall()
    cursor.close()
    db.close()
    return jsonify(data)


@outage_bp.route('/add-complaint', methods=['POST'])
def add_complaint():
    data = request.get_json(silent=True) or {}
    description = data.get('description')
    citizen_id = data.get('citizen_id')

    if not description:
        return jsonify({'status': 'error', 'message': 'description is required'}), 400
    if citizen_id is None:
        return jsonify({'status': 'error', 'message': 'citizen_id is required'}), 400

    db = get_db_connection()
    cursor = db.cursor()

    cursor.execute('SELECT citizen_id FROM citizen WHERE citizen_id = %s', (citizen_id,))
    if cursor.fetchone() is None:
        cursor.close()
        db.close()
        return jsonify({'status': 'error', 'message': 'Invalid citizen_id'}), 400

    query = """
    INSERT INTO outage_report (report_time, description, report_status, citizen_id)
    VALUES (NOW(), %s, 'OPEN', %s)
    """
    cursor.execute(query, (description, citizen_id))
    db.commit()
    report_id = cursor.lastrowid
    cursor.close()
    db.close()

    return jsonify({'status': 'success', 'message': 'Complaint added successfully', 'report_id': report_id}), 201


@outage_bp.route('/complaints', methods=['GET'])
def get_complaints():
    db = get_db_connection()
    cursor = db.cursor(dictionary=True)
    cursor.execute('SELECT * FROM outage_report ORDER BY report_id DESC')
    data = cursor.fetchall()
    cursor.close()
    db.close()
    return jsonify(data)


@outage_bp.route('/update-complaint', methods=['POST'])
def update_complaint():
    data = request.get_json(silent=True) or {}
    report_id = data.get('report_id')
    report_status = data.get('report_status')

    if report_id is None or not report_status:
        return jsonify({'status': 'error', 'message': 'report_id and report_status are required'}), 400

    db = get_db_connection()
    cursor = db.cursor()
    cursor.execute(
        'UPDATE outage_report SET report_status = %s WHERE report_id = %s',
        (report_status, report_id)
    )
    db.commit()
    affected = cursor.rowcount
    cursor.close()
    db.close()

    if affected == 0:
        return jsonify({'status': 'error', 'message': 'Complaint not found'}), 404

    return jsonify({'status': 'success', 'message': 'Complaint status updated'})
