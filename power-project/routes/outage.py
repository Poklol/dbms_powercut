from datetime import datetime, timedelta
from flask import Blueprint, jsonify, request
from db import get_db_connection

outage_bp = Blueprint('outage', __name__)
_schema_ready = False

TECHNICIANS = [
    'Field Team A',
    'Field Team B',
    'Rapid Response Crew',
    'Transformer Unit 1',
    'Transformer Unit 2'
]

PRIORITY_ORDER = {
    'CRITICAL': 4,
    'HIGH': 3,
    'MEDIUM': 2,
    'LOW': 1
}

SLA_HOURS = {
    'CRITICAL': 2,
    'HIGH': 4,
    'MEDIUM': 8,
    'LOW': 24
}


def _ensure_worker_schema():
    global _schema_ready
    if _schema_ready:
        return

    db = get_db_connection()
    cursor = db.cursor()

    required_columns = {
        'issue_category': 'VARCHAR(50) NULL',
        'priority': 'VARCHAR(20) NULL',
        'assigned_to': 'VARCHAR(120) NULL',
        'eta_deadline': 'DATETIME NULL',
        'accepted_at': 'DATETIME NULL',
        'resolved_at': 'DATETIME NULL',
        'updated_at': 'DATETIME NULL'
    }

    for col, col_type in required_columns.items():
        cursor.execute(
            '''
            SELECT COUNT(*)
            FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'outage_report'
              AND column_name = %s
            ''',
            (col,)
        )
        if cursor.fetchone()[0] == 0:
            cursor.execute(f'ALTER TABLE outage_report ADD COLUMN {col} {col_type}')

    cursor.execute(
        '''
        CREATE TABLE IF NOT EXISTS outage_report_note (
            note_id INT AUTO_INCREMENT PRIMARY KEY,
            report_id INT NOT NULL,
            action_type VARCHAR(60) NULL,
            note_text TEXT NULL,
            created_by VARCHAR(120) NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (report_id) REFERENCES outage_report(report_id) ON DELETE CASCADE
        )
        '''
    )

    db.commit()
    cursor.close()
    db.close()
    _schema_ready = True



def _classify_issue(description):
    text = (description or '').lower()

    if any(word in text for word in ['spark', 'smoke', 'burn', 'fire', 'blast', 'transformer fault']):
        return 'TRANSFORMER_FAULT'
    if any(word in text for word in ['overload', 'high load', 'load issue']):
        return 'OVERLOAD'
    if any(word in text for word in ['voltage', 'fluctuation', 'low voltage', 'high voltage']):
        return 'VOLTAGE'
    if any(word in text for word in ['outage', 'blackout', 'power cut', 'no power']):
        return 'SUPPLY_OUTAGE'
    return 'UNKNOWN'



def _priority_from_category(issue_category):
    mapping = {
        'TRANSFORMER_FAULT': 'CRITICAL',
        'OVERLOAD': 'HIGH',
        'VOLTAGE': 'MEDIUM',
        'SUPPLY_OUTAGE': 'MEDIUM',
        'UNKNOWN': 'LOW'
    }
    return mapping.get(issue_category, 'LOW')



def _eta_deadline(report_time, priority):
    base = report_time or datetime.utcnow()
    sla_hours = SLA_HOURS.get(priority, 24)
    return base + timedelta(hours=sla_hours)



def _get_notes(cursor, report_id):
    cursor.execute(
        '''
        SELECT note_id, action_type, note_text, created_by, created_at
        FROM outage_report_note
        WHERE report_id = %s
        ORDER BY created_at DESC
        LIMIT 20
        ''',
        (report_id,)
    )
    rows = cursor.fetchall()
    notes = []
    for row in rows:
        notes.append(
            {
                'note_id': row.get('note_id'),
                'action_type': row.get('action_type'),
                'note_text': row.get('note_text'),
                'created_by': row.get('created_by'),
                'created_at': row.get('created_at')
            }
        )
    return notes



def _get_transformer_context(cursor, outage_id):
    transformer_id = None

    if outage_id is not None:
        cursor.execute(
            'SELECT transformer_id FROM power_outage WHERE outage_id = %s LIMIT 1',
            (outage_id,)
        )
        row = cursor.fetchone()
        if row and row.get('transformer_id') is not None:
            transformer_id = row.get('transformer_id')

    if transformer_id is None:
        cursor.execute(
            '''
            SELECT transformer_id
            FROM transformer
            ORDER BY (operational_status = 'FAULT') DESC, (current_load / NULLIF(capacity, 0)) DESC
            LIMIT 1
            '''
        )
        row = cursor.fetchone()
        if row:
            transformer_id = row.get('transformer_id')

    if transformer_id is None:
        return None

    cursor.execute(
        '''
        SELECT transformer_id, operational_status, current_load, capacity, latitude, longitude
        FROM transformer
        WHERE transformer_id = %s
        LIMIT 1
        ''',
        (transformer_id,)
    )
    t = cursor.fetchone()
    if not t:
        return None

    cursor.execute(
        '''
        SELECT sr.sensor_id, sr.temperature, sr.voltage, sr.load_value, sr.timestamp
        FROM sensor s
        JOIN sensor_reading sr ON sr.sensor_id = s.sensor_id
        WHERE s.transformer_id = %s
        ORDER BY sr.timestamp DESC, sr.reading_id DESC
        LIMIT 1
        ''',
        (transformer_id,)
    )
    reading = cursor.fetchone()

    lat = float(t.get('latitude')) if t.get('latitude') is not None else None
    lon = float(t.get('longitude')) if t.get('longitude') is not None else None
    map_url = None
    if lat is not None and lon is not None:
        map_url = f'https://www.openstreetmap.org/?mlat={lat}&mlon={lon}#map=15/{lat}/{lon}'

    context = {
        'transformer_id': t.get('transformer_id'),
        'status': t.get('operational_status'),
        'current_load': float(t.get('current_load')) if t.get('current_load') is not None else None,
        'capacity': float(t.get('capacity')) if t.get('capacity') is not None else None,
        'latitude': lat,
        'longitude': lon,
        'map_url': map_url,
        'last_sensor_reading': None
    }

    if reading:
        context['last_sensor_reading'] = {
            'sensor_id': reading.get('sensor_id'),
            'temperature': float(reading.get('temperature')) if reading.get('temperature') is not None else None,
            'voltage': float(reading.get('voltage')) if reading.get('voltage') is not None else None,
            'load_value': float(reading.get('load_value')) if reading.get('load_value') is not None else None,
            'timestamp': reading.get('timestamp')
        }

    return context



def _build_complaint_payload(cursor, row):
    report_id = row['report_id']
    issue_category = row.get('issue_category') or _classify_issue(row.get('description'))
    priority = row.get('priority') or _priority_from_category(issue_category)

    report_time = row.get('report_time') or datetime.utcnow()
    eta_deadline = row.get('eta_deadline') or _eta_deadline(report_time, priority)
    now = datetime.utcnow()

    overdue = eta_deadline < now and (row.get('report_status') or '').upper() != 'RESOLVED'
    eta_seconds_remaining = int((eta_deadline - now).total_seconds())

    context = _get_transformer_context(cursor, row.get('outage_id'))
    notes = _get_notes(cursor, report_id)

    return {
        'report_id': report_id,
        'report_time': report_time,
        'description': row.get('description'),
        'report_status': row.get('report_status'),
        'outage_id': row.get('outage_id'),
        'citizen_id': row.get('citizen_id'),
        'issue_category': issue_category,
        'priority': priority,
        'priority_rank': PRIORITY_ORDER.get(priority, 1),
        'assigned_to': row.get('assigned_to'),
        'eta_deadline': eta_deadline,
        'eta_seconds_remaining': eta_seconds_remaining,
        'is_overdue': overdue,
        'accepted_at': row.get('accepted_at'),
        'resolved_at': row.get('resolved_at'),
        'transformer_context': context,
        'notes': notes
    }


@outage_bp.route('/worker-technicians', methods=['GET'])
def get_worker_technicians():
    return jsonify({'status': 'success', 'technicians': TECHNICIANS})


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
    _ensure_worker_schema()

    data = request.get_json(silent=True) or {}
    description = data.get('description')
    citizen_id = data.get('citizen_id')

    if not description:
        return jsonify({'status': 'error', 'message': 'description is required'}), 400
    if citizen_id is None:
        return jsonify({'status': 'error', 'message': 'citizen_id is required'}), 400

    issue_category = _classify_issue(description)
    priority = _priority_from_category(issue_category)
    report_time = datetime.utcnow()
    eta_deadline = _eta_deadline(report_time, priority)

    db = get_db_connection()
    cursor = db.cursor()

    cursor.execute('SELECT citizen_id FROM citizen WHERE citizen_id = %s', (citizen_id,))
    if cursor.fetchone() is None:
        cursor.close()
        db.close()
        return jsonify({'status': 'error', 'message': 'Invalid citizen_id'}), 400

    query = '''
    INSERT INTO outage_report (report_time, description, report_status, citizen_id, issue_category, priority, eta_deadline, updated_at)
    VALUES (%s, %s, 'OPEN', %s, %s, %s, %s, %s)
    '''
    cursor.execute(
        query,
        (report_time, description, citizen_id, issue_category, priority, eta_deadline, report_time)
    )
    db.commit()
    report_id = cursor.lastrowid

    cursor.execute(
        '''
        INSERT INTO outage_report_note(report_id, action_type, note_text, created_by)
        VALUES (%s, 'CREATED', %s, %s)
        ''',
        (report_id, 'Complaint created from citizen dashboard', f'Citizen {citizen_id}')
    )
    db.commit()

    cursor.close()
    db.close()

    return jsonify({'status': 'success', 'message': 'Complaint added successfully', 'report_id': report_id}), 201


@outage_bp.route('/complaints', methods=['GET'])
def get_complaints():
    _ensure_worker_schema()

    db = get_db_connection()
    cursor = db.cursor(dictionary=True)
    cursor.execute('SELECT * FROM outage_report ORDER BY report_time ASC')
    rows = cursor.fetchall()

    # Build enriched response and softly backfill missing category/priority/eta values.
    enriched = []
    for row in rows:
        payload = _build_complaint_payload(cursor, row)
        enriched.append(payload)

        if row.get('issue_category') is None or row.get('priority') is None or row.get('eta_deadline') is None:
            cursor.execute(
                '''
                UPDATE outage_report
                SET issue_category = %s,
                    priority = %s,
                    eta_deadline = %s,
                    updated_at = %s
                WHERE report_id = %s
                ''',
                (payload['issue_category'], payload['priority'], payload['eta_deadline'], datetime.utcnow(), row['report_id'])
            )

    db.commit()
    cursor.close()
    db.close()
    return jsonify(enriched)


@outage_bp.route('/update-complaint', methods=['POST'])
def update_complaint():
    _ensure_worker_schema()

    data = request.get_json(silent=True) or {}
    report_id = data.get('report_id')
    action = (data.get('action') or '').strip().lower()
    report_status = data.get('report_status')
    assigned_to = data.get('assigned_to')
    issue_category = data.get('issue_category')
    note_text = data.get('note_text')
    updated_by = data.get('updated_by') or 'Worker Deck'

    if report_id is None:
        return jsonify({'status': 'error', 'message': 'report_id is required'}), 400

    db = get_db_connection()
    cursor = db.cursor(dictionary=True)

    cursor.execute('SELECT * FROM outage_report WHERE report_id = %s', (report_id,))
    row = cursor.fetchone()
    if row is None:
        cursor.close()
        db.close()
        return jsonify({'status': 'error', 'message': 'Complaint not found'}), 404

    now = datetime.utcnow()
    new_status = (row.get('report_status') or 'OPEN').upper()

    if action == 'accept':
        new_status = 'ACCEPTED'
    elif action == 'start_progress':
        new_status = 'IN_PROGRESS'
    elif action == 'resolve':
        new_status = 'RESOLVED'
    elif action == 'set_status' and report_status:
        new_status = str(report_status).upper()

    if issue_category:
        issue_category = str(issue_category).upper()
    else:
        issue_category = row.get('issue_category') or _classify_issue(row.get('description'))

    priority = _priority_from_category(issue_category)
    eta_deadline = row.get('eta_deadline') or _eta_deadline(row.get('report_time') or now, priority)

    accepted_at = row.get('accepted_at')
    resolved_at = row.get('resolved_at')

    if new_status in ['ACCEPTED', 'IN_PROGRESS'] and accepted_at is None:
        accepted_at = now

    if new_status == 'RESOLVED':
        resolved_at = now

    cursor.execute(
        '''
        UPDATE outage_report
        SET report_status = %s,
            assigned_to = %s,
            issue_category = %s,
            priority = %s,
            eta_deadline = %s,
            accepted_at = %s,
            resolved_at = %s,
            updated_at = %s
        WHERE report_id = %s
        ''',
        (
            new_status,
            assigned_to if assigned_to is not None else row.get('assigned_to'),
            issue_category,
            priority,
            eta_deadline,
            accepted_at,
            resolved_at,
            now,
            report_id
        )
    )

    action_type = action.upper() if action else 'UPDATE'
    if action_type == '':
        action_type = 'UPDATE'

    if note_text or action:
        cursor.execute(
            '''
            INSERT INTO outage_report_note(report_id, action_type, note_text, created_by)
            VALUES (%s, %s, %s, %s)
            ''',
            (report_id, action_type, note_text or f'Status changed to {new_status}', updated_by)
        )

    db.commit()
    cursor.close()
    db.close()

    return jsonify({'status': 'success', 'message': 'Complaint updated', 'report_status': new_status})
