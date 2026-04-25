from flask import Blueprint, jsonify, request
from db import get_db_connection

auth_bp = Blueprint('auth', __name__)


@auth_bp.route('/login', methods=['POST'])
def login():
    data = request.get_json(silent=True) or {}
    username = data.get('username')
    password = data.get('password')

    if not username or not password:
        return jsonify({'status': 'error', 'message': 'username and password are required'}), 400

    db = get_db_connection()
    cursor = db.cursor(dictionary=True)
    cursor.execute(
        'SELECT user_id, role, citizen_id FROM users WHERE username = %s AND password = %s',
        (username, password)
    )
    user = cursor.fetchone()
    cursor.close()
    db.close()

    if user:
        return jsonify(
            {
                'status': 'success',
                'user_id': user['user_id'],
                'role': user['role'],
                'citizen_id': user['citizen_id']
            }
        )

    return jsonify({'status': 'error', 'message': 'Invalid credentials'}), 401
