#!/usr/bin/env python3
"""SkuVault web interface service for extracting operational data.

This service implements web interface integration for SkuVault, using
the discovered real API endpoints rather than HTML parsing.

The service handles:
- Authentication via web login
- Session management with cookies
- API calls to real data endpoints
- Rate limiting and error handling
- Data extraction and parsing

Example:
    ```python
    from jerky_data_hub.services.skuvault_web_service import SkuVaultWebService

    async with SkuVaultWebService() as service:
        success = await service.login()
        if success:
            sessions = await service.get_sessions_by_sale_id("1-352444-5-13038-138162-JK3825331504")
            print(f"Found {len(sessions)} sessions")
            if sessions:
                print(f"First session ID: {sessions[0].session_id}")
    ```
"""

import asyncio
import json
import time
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from jerky_data_hub.models.skuvault.sessions import SessionOrder

import requests
from bs4 import BeautifulSoup

from jerky_data_hub.models.logging import (
    ErrorContext,
    ErrorDetail,
    LogContext,
    ErrorDetails,
    ServiceDetails
)
from jerky_data_hub.models.skuvault.directions import (DirectionsResponse,
                                                       ParsedDirection)
from jerky_data_hub.models.skuvault.sessions import (ParsedSession,
                                                     SessionOrder,
                                                     SessionsResponse,
                                                     SessionState)
from jerky_data_hub.services.cloud_logging_service import CloudLoggingService
from jerky_data_hub.services.firestore_service import FirestoreService
from jerky_data_hub.services.settings_service import Settings
from jerky_data_hub.services.token_cache_service import TokenCacheService


class DirectionsCache:
    """In-memory cache for directions responses by picklist ID.

    This cache stores parsed directions and history data to avoid
    redundant API calls for the same picklist ID within a session.

    Attributes:
        _cache: Dictionary mapping picklist_id to cached data
        _max_size: Maximum number of cached items
        _ttl_seconds: Time-to-live for cached items in seconds
    """

    def __init__(self, max_size: int = 100, ttl_seconds: int = 3600):
        """Initialize the directions cache.

        Args:
            max_size: Maximum number of cached items (default: 100)
            ttl_seconds: Time-to-live for cached items in seconds (default: 1 hour)
        """
        self._cache: Dict[str, Dict[str, Any]] = {}
        self._max_size = max_size
        self._ttl_seconds = ttl_seconds

    def get(self, picklist_id: str) -> Optional[Dict[str, Any]]:
        """Get cached directions data for a picklist ID.

        Args:
            picklist_id: The picklist ID to retrieve

        Returns:
            Cached data if valid and not expired, None otherwise
        """
        if picklist_id not in self._cache:
            return None

        cached_item = self._cache[picklist_id]
        current_time = time.time()

        # Check if item has expired
        if current_time - cached_item["timestamp"] > self._ttl_seconds:
            # Remove expired item
            del self._cache[picklist_id]
            return None

        return cached_item["data"]

    def set(self, picklist_id: str, data: Dict[str, Any]) -> None:
        """Cache directions data for a picklist ID.

        Args:
            picklist_id: The picklist ID to cache
            data: The directions data to cache
        """
        # Implement LRU eviction if cache is full
        if len(self._cache) >= self._max_size:
            self._evict_oldest()

        self._cache[picklist_id] = {
            "data": data,
            "timestamp": time.time(),
        }

    def invalidate(self, picklist_id: str) -> None:
        """Invalidate cached data for a specific picklist ID.

        Args:
            picklist_id: The picklist ID to invalidate
        """
        if picklist_id in self._cache:
            del self._cache[picklist_id]

    def clear(self) -> None:
        """Clear all cached data."""
        self._cache.clear()

    def _evict_oldest(self) -> None:
        """Evict the oldest cached item based on timestamp."""
        if not self._cache:
            return

        oldest_key = min(self._cache.keys(), key=lambda k: self._cache[k]["timestamp"])
        del self._cache[oldest_key]

    def get_stats(self) -> Dict[str, Any]:
        """Get cache statistics for monitoring.

        Returns:
            Dictionary containing cache statistics
        """
        current_time = time.time()
        expired_count = sum(
            1
            for item in self._cache.values()
            if current_time - item["timestamp"] > self._ttl_seconds
        )

        return {
            "total_items": len(self._cache),
            "max_size": self._max_size,
            "expired_items": expired_count,
            "utilization_percent": (len(self._cache) / self._max_size) * 100,
        }


class SkuVaultWebService:
    """Service for SkuVault web interface integration using discovered API endpoints."""

    def __init__(self):
        """Initialize the web service."""
        self.settings = Settings.get()
        self.session = requests.Session()
        self.logger = CloudLoggingService("skuvault.web")
        self.is_authenticated = False
        self.auth_token = None

        # Initialize token cache service
        self.token_cache = TokenCacheService()

        # Initialize directions cache
        self.directions_cache = DirectionsCache(
            max_size=self.settings.skuvault.scraping.cache.max_directions_cache_size,
            ttl_seconds=self.settings.skuvault.scraping.cache.directions_cache_ttl_seconds,
        )

        # Initialize CORS preflight cache for efficiency
        self.cors_preflight_cache = {}
        self.cors_preflight_ttl = 300  # 5 minutes TTL for preflight responses

        # Configure session with base headers
        self.session.headers.update(
            {
                "User-Agent": self.settings.skuvault.scraping.web.user_agent,
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "en-US,en;q=0.9",
                "Accept-Encoding": "gzip, deflate, br",
                "Connection": "keep-alive",
                "Sec-Fetch-Dest": "empty",
                "Sec-Fetch-Mode": "cors",
                "Sec-Fetch-Site": "same-site",
            }
        )

    def _get_all_session_states(self) -> List[str]:
        """Get all valid session states for API requests.

        Returns:
            List of session state string values for API consumption
        """
        return [state.value for state in SessionState]

    def get_session_states_by_names(self, state_names: List[str]) -> List[str]:
        """Get session state values by their names or values, with validation.

        This method accepts both enum names (e.g., "READY_TO_SHIP") and enum values (e.g., "readyToShip")
        and converts them to the appropriate string values for API consumption.

        Args:
            state_names: List of state names or values to convert to API values

        Returns:
            List of validated session state string values

        Raises:
            ValueError: If any state name or value is invalid
        """
        valid_states = []
        for name in state_names:
            try:
                # First try to find state by name (case-insensitive)
                state = next(
                    (s for s in SessionState if s.name.lower() == name.lower()), None
                )

                # If not found by name, try to find by value (case-insensitive)
                if not state:
                    state = next(
                        (s for s in SessionState if s.value.lower() == name.lower()), None
                    )

                if state:
                    valid_states.append(state.value)
                else:
                    raise ValueError(f"Invalid session state: {name}")
            except Exception as e:
                raise ValueError(f"Invalid session state '{name}': {e}")

        return valid_states

    def validate_session_state(self, state_value: str) -> bool:
        """Validate if a session state value is valid.

        Args:
            state_value: The state value to validate

        Returns:
            True if valid, False otherwise
        """
        try:
            SessionState(state_value)
            return True
        except ValueError:
            return False

    async def __aenter__(self):
        """Async context manager entry."""
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit."""
        self.logout()

    async def login(self) -> bool:
        """Authenticate with SkuVault web interface.

        Returns:
            True if login successful, False otherwise
        """
        try:
            # First check if we have a valid cached token
            if await self.check_cached_token():
                self.logger.info(
                    LogContext(
                        step="login",
                        action="cached_token_used",
                        details=ServiceDetails(
                            status="success"
                        ),
                    )
                )
                return True

            self.logger.info(
                LogContext(
                    step="login",
                    action="start_login",
                    details=ServiceDetails(
                        status="starting"
                    ),
                )
            )

            # Get login page to extract form data
            login_response = await self._make_request(
                "GET",
                str(self.settings.skuvault.scraping.web.login_url),
                "get_login_page",
            )

            if not login_response:
                self.logger.error(
                    ErrorContext(
                        error=ErrorDetail(
                            type="RequestError",
                            message="Failed to get login page",
                            traceback="",
                        ),
                        details=ErrorDetails(
                            step="login",
                            action="get_login_page_failed",
                            error_type="request_error"
                        ),
                    )
                )
                return False

            # Parse login form
            soup = BeautifulSoup(login_response.text, "lxml")
            form = soup.find("form")

            if not form:
                self.logger.error(
                    ErrorContext(
                        error=ErrorDetail(
                            type="ParseError",
                            message="Login form not found on page",
                            traceback="",
                        ),
                        details=ErrorDetails(
                            step="login",
                            action="form_not_found",
                            error_type="parse_error"
                        ),
                    )
                )
                return False

            self.logger.info(
                LogContext(
                    step="login",
                    action="form_found",
                    details=ServiceDetails(
                        status="success"
                    ),
                )
            )

            # Prepare login data
            login_data = {
                "Email": self.settings.skuvault.scraping.web.username,
                "Password": self.settings.skuvault.scraping.web.password,
            }

            # Submit login form
            login_response = await self._make_request(
                "POST",
                str(self.settings.skuvault.scraping.web.login_url),
                "submit_login",
                data=login_data,
            )

            if not login_response:
                return False

            # Check if login was successful
            success = self._is_login_successful(login_response)

            if success:
                self.is_authenticated = True
                self._extract_auth_token()

                # Store token in cache if extraction was successful
                if self.auth_token:
                    await self._store_token_in_cache()

                self.logger.info(
                    LogContext(
                        step="login",
                        action="login_successful",
                        details=ServiceDetails(
                            status="success"
                        ),
                    )
                )
            else:
                self.logger.error(
                    ErrorContext(
                        error=ErrorDetail(
                            type="AuthenticationError",
                            message="Login credentials rejected or unexpected response",
                            traceback="",
                        ),
                        details=ErrorDetails(
                            step="login",
                            action="login_failed",
                            error_type="authentication_error"
                        ),
                    )
                )

            return success

        except Exception as e:
            self.logger.error(
                ErrorContext(
                    error=ErrorDetail(
                        type=type(e).__name__, message=str(e), traceback=""
                    ),
                    details=ErrorDetails(
                        step="login",
                        action="login_exception",
                        error_type="login_error"
                    ),
                )
            )
            return False

    async def get_sessions_by_sale_id(self, sale_id: str) -> List[ParsedSession]:
        """Get sessions data for a specific sale ID using the real API endpoint.

        Args:
            sale_id: The sale ID to search for

        Returns:
            List of parsed session data
        """
        if not self.is_authenticated:
            self.logger.error(
                ErrorContext(
                    error=ErrorDetail(
                        type="AuthenticationError",
                        message="Service not authenticated",
                        traceback="",
                    ),
                    details=ErrorDetails(
                        step="get_sessions",
                        action="not_authenticated",
                        error_type="authentication_error"
                    ),
                )
            )
            return []

        try:
            self.logger.info(
                LogContext(
                    step="get_sessions",
                    action="search_by_sale_id",
                    details=ServiceDetails(
                        status="searching"
                    ),
                )
            )

            # Use the discovered real API endpoint
            api_url = "https://lmdb.skuvault.com/wavepicking/get/sessions"

            # Use the service's default headers (set in _set_api_headers)
            # Only add Content-Type for this specific request
            headers = {"Content-Type": "application/json"}

            # Prepare request payload with correct structure based on actual API
            payload = {
                "limit": 100,
                "skip": 0,
                "userId": "-2",  # System-wide identifier for all users
                "sort": [{"descending": False, "field": "createdDate"}],
                "states": self._get_all_session_states(),
                "saleId": {"match": "contains", "value": sale_id},
            }

            # Make API request
            response = await self._make_request(
                "POST", api_url, "get_sessions_api", json_data=payload, headers=headers
            )

            if not response:
                return []

            # Parse the JSON response
            try:
                data = response.json()
                return self._parse_sessions_response(data, sale_id)
            except json.JSONDecodeError as e:
                self.logger.error(
                    ErrorContext(
                        error=ErrorDetail(
                            type="JSONDecodeError",
                            message=f"Failed to parse API response: {e}",
                            traceback="",
                        ),
                        details=ErrorDetails(
                            step="get_sessions",
                            action="json_parse_error",
                            error_type="json_parse_error"
                        ),
                    )
                )
                return []

        except Exception as e:
            self.logger.error(
                ErrorContext(
                    error=ErrorDetail(
                        type=type(e).__name__, message=str(e), traceback=""
                    ),
                    details=ErrorDetails(
                        step="get_sessions",
                        action="get_sessions_exception",
                        error_type="get_sessions_error"
                    ),
                )
            )
            return []

    async def get_all_sessions(
        self, limit: int = 100, skip: int = 0, sort_descending: bool = True, states: Optional[List[str]] = None
    ) -> List[ParsedSession]:
        """Get all sessions with pagination and sorting.

        Args:
            limit: Maximum number of sessions to return (default 100)
            skip: Number of sessions to skip for pagination (default 0)
            sort_descending: Whether to sort by creation date descending (default True)
            states: Optional list of state names to filter by (e.g., ["active", "new"])

        Returns:
            List of parsed session data
        """
        if not self.is_authenticated:
            self.logger.error(
                ErrorContext(
                    step="get_all_sessions",
                    action="not_authenticated",
                    error=ErrorDetail(
                        type="AuthenticationError",
                        message="Service not authenticated",
                        traceback="",
                    ),
                ),
            )
            return []

        try:
            # Convert state names to values if provided
            state_values = None
            if states:
                try:
                    state_values = self.get_session_states_by_names(states)
                except ValueError as e:
                    self.logger.error(
                        ErrorContext(
                            step="get_all_sessions",
                            action="invalid_states",
                            error=ErrorDetail(
                                type="ValueError",
                                message=f"Invalid state names: {e}",
                                traceback="",
                            ),
                        ),
                    )
                    return []

            self.logger.info(
                LogContext(
                    step="get_all_sessions",
                    action="get_all_sessions",
                    details=ServiceDetails(status="requesting"),
                ),
            )

            # Use the discovered real API endpoint
            api_url = "https://lmdb.skuvault.com/wavepicking/get/sessions"

            # Use the service's default headers (set in _set_api_headers)
            # Only add Content-Type for this specific request
            headers = {"Content-Type": "application/json"}

            # Prepare request payload with correct structure based on actual API
            payload = {
                "limit": limit,
                "skip": skip,
                "userId": "-2",  # System-wide identifier for all users
                "sort": [{"descending": sort_descending, "field": "createdDate"}],
                "states": state_values if state_values else self._get_all_session_states(),
            }

            # Make API request
            response = await self._make_request(
                "POST",
                api_url,
                "get_all_sessions_api",
                json_data=payload,
                headers=headers,
            )

            if not response:
                return []

            # Parse the JSON response
            try:
                data = response.json()

                return self._parse_all_sessions_response(data)
            except json.JSONDecodeError as e:
                self.logger.error(
                    ErrorContext(
                        error=ErrorDetail(
                            type="JSONDecodeError",
                            message=f"Failed to parse API response: {e}",
                            traceback="",
                        ),
                        details=ErrorDetails(
                            step="get_all_sessions",
                            action="json_parse_error",
                            error_type="json_parse_error"
                        ),
                    )
                )
                return []

        except Exception as e:
            self.logger.error(
                ErrorContext(
                    error=ErrorDetail(
                        type=type(e).__name__, message=str(e), traceback=""
                    ),
                    details=ErrorDetails(
                        step="get_all_sessions",
                        action="get_all_sessions_exception",
                        error_type="get_all_sessions_error"
                    ),
                )
            )
            return []

    def _extract_auth_token(self):
        """Extract authentication token from session cookies or response."""
        # Look for the auth token in the sv-t cookie
        # This cookie contains the Bearer token needed for API calls

        auth_token = None

        # Check for the sv-t cookie which contains the authentication token
        for cookie in self.session.cookies:
            if cookie.name == "sv-t" and len(cookie.value) > 100:
                auth_token = cookie.value
                break

        if auth_token:
            self.auth_token = auth_token
            # Set the required API headers for all subsequent requests
            self._set_api_headers()
            self.logger.info(
                LogContext(
                    step="authentication",
                    action="token_extracted",
                    details=ServiceDetails(
                        status="success"
                    ),
                ),
            )
        else:
            self.logger.warning(
                LogContext(
                    step="authentication",
                    action="token_not_found",
                    details=ServiceDetails(
                        status="failed"
                    ),
                ),
            )

    async def _store_token_in_cache(self):
        """Store the extracted authentication token in the cache."""
        try:
            if not self.auth_token:
                return

            # Store token in cache with 24-hour expiration
            success = await self.token_cache.store_token(
                token=self.auth_token,
                source="skuvault_web",
                expires_in_hours=24,
                metadata={
                    "username": self.settings.skuvault.scraping.web.username,
                    "login_url": str(self.settings.skuvault.scraping.web.login_url),
                    "extracted_at": time.time(),
                },
            )

            if success:
                self.logger.info(
                    LogContext(
                        step="token_cache",
                        action="token_stored",
                        details=ServiceDetails(
                            status="success"
                        ),
                    )
                )
            else:
                self.logger.warning(
                    LogContext(
                        step="token_cache",
                        action="storage_failed",
                        details=ServiceDetails(
                            status="failed"
                        ),
                    )
                )

        except Exception as e:
            self.logger.error(
                ErrorContext(
                    error=ErrorDetail(
                        type=type(e).__name__,
                        message=f"Failed to store token in cache: {e}",
                        traceback="",
                    ),
                    details=ErrorDetails(
                        step="token_cache",
                        action="storage_exception",
                        error_type="storage_error"
                    ),
                )
            )

    def _set_api_headers(self):
        """Set the required headers for API calls to lmdb.skuvault.com."""
        api_headers = {
            "Authorization": f"Token {self.auth_token}",
            "Partition": "default",
            "tid": str(int(time.time())),
            "idempotency-key": str(uuid.uuid4()),
            "dataread": "true",
        }
        self.session.headers.update(api_headers)

        # Invalidate CORS preflight cache when authentication changes
        # This ensures we re-validate preflight when using new tokens
        if self.cors_preflight_cache:
            old_cache_size = len(self.cors_preflight_cache)
            self.cors_preflight_cache.clear()
            self.logger.info(
                LogContext(
                    step="cors_preflight",
                    action="cache_invalidated",
                    details={
                        "reason": "authentication_changed",
                        "cleared_entries": old_cache_size,
                        "new_auth_token_length": len(self.auth_token) if self.auth_token else 0,
                    },
                )
            )

    def _parse_sessions_response(
        self, data: Dict[str, Any], sale_id: str
    ) -> List[ParsedSession]:
        """Parse the sessions API response into structured data.

        Args:
            data: The JSON response from the sessions API
            sale_id: The original sale ID searched for

        Returns:
            List of parsed session data
        """
        sessions = []

        try:
            lists = data.get("lists", [])

            for session_data in lists:
                # Convert string state to SessionState enum
                state_str = session_data.get("state")
                status = None
                if state_str:
                    try:
                        status = SessionState(state_str)
                    except ValueError:
                        self.logger.warning(
                            LogContext(
                                step="parse_sessions",
                                action="invalid_state",
                                details={
                                    "state": state_str,
                                    "session_id": session_data.get("sequenceId"),
                                },
                            )
                        )

                # Debug: Log the assigned data structure
                assigned_data = session_data.get("assigned", {})
                self.logger.debug(
                    LogContext(
                        step="parse_sessions",
                        action="debug_assigned_data",
                        details={
                            "session_id": session_data.get("sequenceId"),
                            "assigned_data": assigned_data,
                            "assigned_keys": list(assigned_data.keys()) if assigned_data else [],
                            "assigned_name": assigned_data.get("name") if assigned_data else None,
                            "assigned_userId": assigned_data.get("userId") if assigned_data else None,
                        },
                    )
                )

                session = ParsedSession(
                    session_id=session_data.get("sequenceId"),
                    picklist_id=session_data.get("picklistId"),
                    status=status,
                    created_date=session_data.get("date"),
                    assigned_user=(
                        session_data.get("assigned", {}).get("name")
                        if session_data.get("assigned")
                        else None
                    ),
                    user_id=(
                        session_data.get("assigned", {}).get("userId")
                        if session_data.get("assigned")
                        else None
                    ),
                    sku_count=session_data.get("skuCount"),
                    order_count=session_data.get("orderCount"),
                    total_quantity=session_data.get("totalQuantity"),
                    picked_quantity=session_data.get("pickedQuantity"),
                    available_quantity=session_data.get("availableQuantity"),
                    total_weight=session_data.get("totalItemsWeight"),
                    view_url=(
                        f"/wave-pick/sessions/{session_data.get('picklistId')}"
                        if session_data.get("picklistId")
                        else None
                    ),
                    extracted_at=time.time(),
                )

                sessions.append(session)

        except Exception as e:
            self.logger.error(
                ErrorContext(
                    step="parse_sessions",
                    action="parse_error",
                    error=ErrorDetail(
                        type=type(e).__name__,
                        message=f"Failed to parse session data: {e}",
                        traceback="",
                    ),
                )
            )

        return sessions

    def _parse_all_sessions_response(self, data: Dict[str, Any]) -> List[ParsedSession]:
        """Parse the all sessions API response into structured data.

        Args:
            data: The JSON response from the all sessions API

        Returns:
            List of parsed session data
        """
        sessions = []

        try:

            # Debug: Log the raw API response structure
            self.logger.info(
                LogContext(
                    step="parse_all_sessions",
                    action="raw_response_structure",
                    details=ServiceDetails(status="debugging"),
                )
            )

            # Parse the response using our Pydantic model
            response = SessionsResponse(**data)

            if response.lists:
                for session_data in response.lists:
                    # Convert string state to SessionState enum
                    status = None
                    if session_data.state:
                        try:
                            status = SessionState(session_data.state)
                        except ValueError:
                            self.logger.warning(
                                LogContext(
                                    step="parse_all_sessions",
                                    action="invalid_state",
                                    details=ServiceDetails(status="invalid_state"),
                                )
                            )

                    # Debug: Log the assigned data structure
                    if session_data.assigned:
                        self.logger.info(
                            LogContext(
                                step="parse_all_sessions",
                                action="debug_assigned_data",
                                details=ServiceDetails(status="debugging"),
                            )
                        )

                    # Map the actual API response fields to our model
                    session = ParsedSession(
                        session_id=session_data.sequenceId,
                        picklist_id=session_data.picklistId,
                        status=status,
                        created_date=session_data.date,
                        assigned_user=(
                            session_data.assigned.name
                            if session_data.assigned
                            else None
                        ),
                        user_id=(
                            session_data.assigned.userId
                            if session_data.assigned
                            else None
                        ),
                        sku_count=session_data.skuCount,
                        order_count=session_data.orderCount,
                        total_quantity=session_data.totalQuantity,
                        picked_quantity=session_data.pickedQuantity,
                        available_quantity=session_data.availableQuantity,
                        total_weight=session_data.totalItemsWeight,
                        view_url=(
                            f"/wave-pick/sessions/{session_data.picklistId}"
                            if session_data.picklistId
                            else None
                        ),
                        extracted_at=time.time(),
                    )
                    sessions.append(session)

        except Exception as e:
            self.logger.error(
                ErrorContext(
                    error=ErrorDetail(
                        type=type(e).__name__,
                        message=f"Failed to parse all sessions data: {e}",
                        traceback="",
                    ),
                    details=ErrorDetails(
                        step="parse_all_sessions",
                        action="parse_error",
                        error_type="parse_error"
                    ),
                )
            )

        return sessions

    def _parse_directions_response(
        self, data: Dict[str, Any], picklist_id: str
    ) -> List[ParsedDirection]:
        """Parse the directions API response into structured data.

        Args:
            data: The JSON response from the directions API
            picklist_id: The original picklist ID

        Returns:
            List of parsed direction data with SKU locations
        """
        self.logger.info(
            LogContext(
                step="parse_directions",
                action="method_started",
                details=ServiceDetails(status="parse_method_entered"),
            )
        )

        directions = []

        try:
            # Debug: Log the actual API response structure
            self.logger.debug(
                LogContext(
                    step="parse_directions",
                    action="debug_response_structure",
                    details=ServiceDetails(status="debugging"),
                )
            )

            # Log the actual API response structure to identify the mismatch
            self.logger.info(
                LogContext(
                    step="parse_directions",
                    action="api_response_structure",
                    details=ServiceDetails(status="logging_structure"),
                )
            )

            # Log the top-level keys to understand the actual API response
            if isinstance(data, dict):
                top_level_keys = list(data.keys())
                self.logger.info(
                    LogContext(
                        step="parse_directions",
                        action="top_level_keys",
                        details=ServiceDetails(status="keys_found"),
                    )
                )
            else:
                self.logger.warning(
                    LogContext(
                        step="parse_directions",
                        action="unexpected_data_type",
                        details=ServiceDetails(status="type_mismatch"),
                    )
                )

            # Parse the response using our Pydantic model
            self.logger.info(
                LogContext(
                    step="parse_directions",
                    action="about_to_instantiate_model",
                    details=ServiceDetails(status="model_instantiation_starting"),
                )
            )

            try:
                self.logger.info(
                    LogContext(
                        step="parse_directions",
                        action="instantiating_directions_response",
                        details=ServiceDetails(status="model_creation_started"),
                    )
                )

                response = DirectionsResponse(**data)

                self.logger.info(
                    LogContext(
                        step="parse_directions",
                        action="model_instantiation_successful",
                        details=ServiceDetails(status="model_created"),
                    )
                )
            except Exception as model_error:
                # Log the specific model instantiation error
                self.logger.error(
                    LogContext(
                        step="parse_directions",
                        action="model_instantiation_failed",
                        details=ServiceDetails(status="model_error"),
                    )
                )

                # Log the actual data structure that caused the failure
                self.logger.error(
                    LogContext(
                        step="parse_directions",
                        action="data_structure_mismatch",
                        details=ServiceDetails(status="structure_error"),
                    )
                )
                                # Return empty list instead of crashing
                return []

                # TODO: The BaseModel error suggests the API response structure
                # doesn't match our models. We need to implement fallback parsing
                # that handles the actual API response format.

            # Extract data from the picklist orders only
            if response.picklist and response.picklist.orders:
                for order_index, order in enumerate(response.picklist.orders, start=1):
                    if order.items:
                        for item in order.items:
                            # Extract location information
                            if item.locations:
                                for location in item.locations:
                                    direction = ParsedDirection(
                                        picklist_id=picklist_id,
                                        sku=item.sku,
                                        sku_name=item.description,
                                        location=location.name,
                                        spot_number=order_index,
                                        bin_info=(
                                            str(location.warehouse_code)
                                            if location.warehouse_code
                                            else None
                                        ),
                                        quantity=item.quantity,
                                        order_number=order.id,
                                        warehouse=location.warehouse_code,
                                        extracted_at=time.time(),
                                    )
                                    directions.append(direction)
                            else:
                                # If no locations, still create a direction entry
                                direction = ParsedDirection(
                                    picklist_id=picklist_id,
                                    sku=item.sku,
                                    sku_name=item.description,
                                    quantity=item.quantity,
                                    order_number=order.id,
                                    spot_number=order_index,
                                    extracted_at=time.time(),
                                )
                                directions.append(direction)

            # Store history data for later use in calculating pick times
            if response.history:
                # Store history in the service instance for access by other methods
                history = response.history
                self.logger.debug(
                    LogContext(
                        step="parse_directions",
                        action="history_parsed",
                        details=ServiceDetails(status="history_parsed"),
                    )
                )
            else:
                self.logger.debug(
                    LogContext(
                        step="parse_directions",
                        action="no_history_found",
                        details=ServiceDetails(status="no_history"),
                    )
                )

        except Exception as e:
            self.logger.error(
                ErrorContext(
                    error=ErrorDetail(
                        type=type(e).__name__,
                        message=f"Failed to parse direction data: {e}",
                        traceback="",
                    ),
                    details=ErrorDetails(
                        step="parse_directions",
                        action="parse_error",
                        error_type="parse_error"
                    ),
                )
            )

        return directions

    def _parse_directions_response_with_history(
        self, data: Dict[str, Any], picklist_id: str
    ) -> tuple[List[ParsedDirection], List[ParsedDirection]]:
        """Parse the directions API response and return both directions and history.

        Args:
            data: The JSON response from the directions API
            picklist_id: The original picklist ID

        Returns:
            Tuple of (List of ParsedDirection, List of ParsedDirection)
        """
        directions = []
        history = []

        try:
            # Parse the response using our Pydantic model
            response = DirectionsResponse(**data)

            # Extract data from the picklist orders only
            if response.picklist and response.picklist.orders:
                for order_index, order in enumerate(response.picklist.orders, start=1):
                    if order.items:
                        for item in order.items:
                            # Extract location information
                            if item.locations:
                                for location in item.locations:
                                    direction = ParsedDirection(
                                        picklist_id=picklist_id,
                                        sku=item.sku,
                                        sku_name=item.description,
                                        location=location.name,
                                        spot_number=order_index,
                                        bin_info=(
                                            str(location.warehouse_code)
                                            if location.warehouse_code
                                            else None
                                        ),
                                        quantity=item.quantity,
                                        order_number=order.id,
                                        warehouse=location.warehouse_code,
                                        extracted_at=time.time(),
                                    )
                                    directions.append(direction)
                            else:
                                # If no locations, still create a direction entry
                                direction = ParsedDirection(
                                    picklist_id=picklist_id,
                                    sku=item.sku,
                                    sku_name=item.description,
                                    quantity=item.quantity,
                                    order_number=order.id,
                                    spot_number=order_index,
                                    extracted_at=time.time(),
                                )
                                directions.append(direction)

            # Store history data for later use in calculating pick times
            if response.history:
                # Store history in the service instance for access by other methods
                history = response.history

        except Exception as e:
            self.logger.error(
                ErrorContext(
                    step="parse_directions",
                    action="parse_error",
                    error=ErrorDetail(
                        type=type(e).__name__,
                        message=f"Failed to parse direction data: {e}",
                        traceback="",
                    ),
                )
            )

        return directions, history

    def _calculate_pick_times_from_history(
        self, sale_id: str
    ) -> tuple[Optional[datetime], Optional[datetime]]:
        """Calculate pick start and end times from directions history.

        Args:
            sale_id: The sale ID to find history for

        Returns:
            Tuple of (pick_start_datetime, pick_end_datetime) or (None, None) if not found
        """
        if (
            not hasattr(self, "_last_directions_history")
            or not self._last_directions_history
        ):
            self.logger.debug(
                LogContext(
                    step="pick_timing",
                    action="no_history_available",
                    details={"sale_id": sale_id, "reason": "No history data stored"},
                )
            )
            return None, None

        # Filter history items for this specific sale ID
        sale_history = [
            item
            for item in self._last_directions_history
            if item.sale_id == sale_id and item.date
        ]

        if not sale_history:
            self.logger.debug(
                LogContext(
                    step="pick_timing",
                    action="no_sale_history",
                    details={
                        "sale_id": sale_id,
                        "total_history_items": len(self._last_directions_history),
                        "available_sale_ids": [
                            item.sale_id
                            for item in self._last_directions_history
                            if item.sale_id
                        ][
                            :5
                        ],  # Show first 5 for debugging
                    },
                )
            )
            return None, None

        # Find earliest and latest dates
        dates = [item.date for item in sale_history if item.date]
        if not dates:
            self.logger.debug(
                LogContext(
                    step="pick_timing",
                    action="no_valid_dates",
                    details={
                        "sale_id": sale_id,
                        "sale_history_count": len(sale_history),
                    },
                )
            )
            return None, None

        pick_start = min(dates)
        pick_end = max(dates)

        self.logger.debug(
            LogContext(
                step="pick_timing",
                action="timing_calculated",
                details={
                    "sale_id": sale_id,
                    "pick_start": pick_start.isoformat() if pick_start else None,
                    "pick_end": pick_end.isoformat() if pick_end else None,
                    "history_items_used": len(sale_history),
                },
            )
        )

        return pick_start, pick_end

    async def get_session_orders(self, session: ParsedSession) -> List[SessionOrder]:
        """Get session orders using the SessionOrderBuilder for consistent logic.

        This method delegates to the SessionOrderBuilder to ensure all orders
        are created with consistent logic and proper user assignment.

        Args:
            session: The session to extract orders from

        Returns:
            List of SessionOrder objects with all fields populated
        """
        if not session.picklist_id:
            self.logger.warning(
                LogContext(
                    step="get_session_orders",
                    action="no_picklist_id",
                    details=ServiceDetails(status="no_picklist"),
                )
            )
            return []

        try:
            # Import here to avoid circular imports
            from jerky_data_hub.services.firestore_service import \
                FirestoreService
            from jerky_data_hub.services.session_order_builder import \
                SessionOrderBuilder

            # Initialize services
            firestore_service = FirestoreService()
            builder = SessionOrderBuilder(
                firestore_service=firestore_service, web_service=self
            )

            # Use the builder to create orders with consistent logic
            self.logger.info(
                LogContext(
                    step="get_session_orders",
                    action="using_builder",
                    details=ServiceDetails(status="using_builder"),
                )
            )

            orders = await builder.build_session_orders(session)

            self.logger.info(
                LogContext(
                    step="get_session_orders",
                    action="builder_complete",
                    details=ServiceDetails(status="builder_complete"),
                )
            )

            return orders

        except Exception as e:
            self.logger.error(
                ErrorContext(
                    error=ErrorDetail(
                        type=type(e).__name__,
                        message=f"Failed to get session orders using builder: {e}",
                        traceback="",
                    ),
                    details=ErrorDetails(
                        step="get_session_orders",
                        action="builder_error",
                        error_type="builder_error",
                    ),
                )
            )
            return []

    async def query_firestore(
        self,
        collection: str,
        limit: int = 100,
        sort_field: Optional[str] = None,
        sort_order: str = "asc",
        filter_field: Optional[str] = None,
        filter_value: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Query Firestore collection with optional filtering and sorting.

        Args:
            collection: Firestore collection name to query
            limit: Maximum number of documents to return
            sort_field: Field to sort by (optional)
            sort_order: Sort order - "asc" or "desc"
            filter_field: Field to filter by (optional)
            filter_value: Value to filter by (optional)

        Returns:
            List of document data dictionaries

        Raises:
            Exception: If Firestore query fails
        """
        try:
            # Ensure environment is loaded before initializing Firestore
            from pathlib import Path

            from dotenv import load_dotenv

            # Load .env file from project root if not already loaded
            project_root = Path(__file__).parent.parent.parent
            env_file = project_root / ".env"
            if env_file.exists():
                load_dotenv(env_file, override=True)
                self.logger.debug(
                    LogContext(
                        step="query_firestore",
                        action="env_loaded",
                        details={"env_file": str(env_file)},
                    )
                )

            # Initialize Firestore service
            firestore_service = FirestoreService()

            # Build query based on collection type
            if collection == "skuvaultOrders":
                if filter_field == "sale_id" and filter_value:
                    # Query by sale_id using our new method
                    order = await firestore_service.get_skuvault_order_by_sale_id(
                        filter_value
                    )
                    return [order] if order else []
                else:
                    # Get all orders (limited)
                    # Note: This is a simplified implementation
                    # In production, you'd want proper pagination
                    self.logger.warning(
                        LogContext(
                            step="query_firestore",
                            action="unsupported_query",
                            details={
                                "collection": collection,
                                "message": "Only sale_id filtering supported for skuvaultOrders",
                            },
                        )
                    )
                    return []
            else:
                self.logger.warning(
                    LogContext(
                        step="query_firestore",
                        action="unsupported_collection",
                        details={
                            "collection": collection,
                            "message": "Collection not yet supported",
                        },
                    )
                )
                return []

        except Exception as e:
            self.logger.error(
                ErrorContext(
                    step="query_firestore",
                    action="query_error",
                    error=ErrorDetail(
                        type=type(e).__name__,
                        message=f"Failed to query Firestore: {e}",
                        traceback="",
                    ),
                    details={
                        "collection": collection,
                        "limit": limit,
                        "filter_field": filter_field,
                        "filter_value": filter_value,
                    },
                )
            )
            raise Exception(f"Firestore query failed: {e}")

    async def get_session_directions(self, picklist_id: str) -> List[ParsedDirection]:
        """Get detailed directions for a specific session including SKU locations.

        This method first checks the cache for existing directions data.
        If not found, it fetches from the API and caches the result.

        Args:
            picklist_id: The picklist ID from the session data

        Returns:
            List of direction data dictionaries with SKU locations and order details
        """
        if not self.is_authenticated:
            self.logger.error(
                ErrorContext(
                    step="get_directions",
                    action="not_authenticated",
                    error=ErrorDetail(
                        type="AuthenticationError",
                        message="Service not authenticated",
                        traceback="",
                    ),
                )
            )
            return []

        try:
            # Check cache first
            self.logger.info(
                LogContext(
                    step="get_directions",
                    action="checking_cache",
                    details=ServiceDetails(status="cache_check"),
                )
            )

            cached_data = self.directions_cache.get(picklist_id)
            if cached_data:
                self.logger.info(
                    LogContext(
                        step="get_directions",
                        action="cache_hit",
                        details=ServiceDetails(status="cache_hit"),
                    )
                )
                self.logger.info(
                    LogContext(
                        step="get_directions",
                        action="parsing_cached_data",
                        details=ServiceDetails(status="starting_parse"),
                    )
                )
                return self._parse_directions_response(cached_data, picklist_id)

            self.logger.info(
                LogContext(
                    step="get_directions",
                    action="get_directions_by_picklist",
                    details=ServiceDetails(status="starting_api_call"),
                )
            )

            # Use the discovered real API endpoint for directions
            api_url = (
                f"https://lmdb.skuvault.com/wavepicking/get/{picklist_id}/directions"
            )

            # Use the service's default headers (set in _set_api_headers)
            # Only add Content-Type for this specific request
            headers = {"Content-Type": "application/json"}

            # Prepare request payload with correct structure based on actual API
            payload = {"includeBinsInfo": True}

            # Make API request
            response = await self._make_request(
                "POST",
                api_url,
                "get_directions_api",
                json_data=payload,
                headers=headers,
            )

            if not response:
                return []

            # Parse the JSON response
            self.logger.info(
                LogContext(
                    step="get_directions",
                    action="parsing_response",
                    details=ServiceDetails(status="json_parse_started"),
                )
            )

            try:
                data = response.json()

                self.logger.info(
                    LogContext(
                        step="get_directions",
                        action="raw_response_received",
                        details=ServiceDetails(status="response_parsed"),
                    )
                )

                # Log the raw response structure to identify the issue
                if isinstance(data, dict):
                    self.logger.info(
                        LogContext(
                            step="get_directions",
                            action="response_structure",
                            details=ServiceDetails(status="structure_logged"),
                        )
                    )
                    # Log the top-level keys
                    top_keys = list(data.keys())
                    self.logger.info(
                        LogContext(
                            step="get_directions",
                            action="top_level_keys",
                            details=ServiceDetails(status=f"keys: {top_keys}"),
                        )
                    )
                else:
                    self.logger.warning(
                        LogContext(
                            step="get_directions",
                            action="unexpected_response_type",
                            details=ServiceDetails(status=f"type: {type(data).__name__}"),
                        )
                    )

                # Cache the raw response data
                self.directions_cache.set(picklist_id, data)

                self.logger.info(
                    LogContext(
                        step="get_directions",
                        action="cached_response",
                        details=ServiceDetails(status="response_cached"),
                    )
                )

                self.logger.info(
                    LogContext(
                        step="get_directions",
                        action="calling_parse_method",
                        details=ServiceDetails(status="parse_started"),
                    )
                )

                return self._parse_directions_response(data, picklist_id)
            except json.JSONDecodeError as e:
                self.logger.error(
                    ErrorContext(
                        step="get_directions",
                        action="json_parse_error",
                        error=ErrorDetail(
                            type="JSONDecodeError",
                            message=f"Failed to parse directions API response: {e}",
                            traceback="",
                        ),
                    )
                )
                return []

        except Exception as e:
            self.logger.error(
                ErrorContext(
                    step="get_directions",
                    action="get_directions_exception",
                    error=ErrorDetail(
                        type=type(e).__name__, message=str(e), traceback=""
                    ),
                )
            )
            return []

    async def _get_raw_directions_response(
        self, picklist_id: str
    ) -> Optional[Dict[str, Any]]:
        """Fetches the raw directions response for a specific picklist ID.

        This method first checks the cache for existing directions data.
        If not found, it fetches from the API and caches the result.

        Args:
            picklist_id: The ID of the picklist to fetch directions for.

        Returns:
            A dictionary containing the raw directions response if successful,
            or None if an error occurred.
        """
        if not self.is_authenticated:
            self.logger.error(
                ErrorContext(
                    step="get_raw_directions_response",
                    action="not_authenticated",
                    error=ErrorDetail(
                        type="AuthenticationError",
                        message="Service not authenticated",
                        traceback="",
                    ),
                )
            )
            return None

        try:
            # Check cache first
            cached_data = self.directions_cache.get(picklist_id)
            if cached_data:
                self.logger.debug(
                    LogContext(
                        step="get_raw_directions_response",
                        action="cache_hit",
                        details={"picklist_id": picklist_id},
                    )
                )
                return cached_data

            self.logger.info(
                LogContext(
                    step="get_raw_directions_response",
                    action="fetch_directions",
                    details={"picklist_id": picklist_id},
                )
            )

            # Use the discovered real API endpoint for directions
            api_url = (
                f"https://lmdb.skuvault.com/wavepicking/get/{picklist_id}/directions"
            )

            # Use the service's default headers (set in _set_api_headers)
            # Only add Content-Type for this specific request
            headers = {"Content-Type": "application/json"}

            # Prepare request payload with correct structure based on actual API
            payload = {"includeBinsInfo": True}

            # Make API request
            response = await self._make_request(
                "POST",
                api_url,
                "get_directions_api",
                json_data=payload,
                headers=headers,
            )

            if not response:
                return None

            # Parse the JSON response
            try:
                data = response.json()

                # Cache the raw response data
                self.directions_cache.set(picklist_id, data)

                self.logger.debug(
                    LogContext(
                        step="get_raw_directions_response",
                        action="cached_response",
                        details={"picklist_id": picklist_id},
                    )
                )

                return data
            except json.JSONDecodeError as e:
                self.logger.error(
                    ErrorContext(
                        step="get_raw_directions_response",
                        action="json_parse_error",
                        error=ErrorDetail(
                            type="JSONDecodeError",
                            message=f"Failed to parse directions API response: {e}",
                            traceback="",
                        ),
                    )
                )
                return None

        except Exception as e:
            self.logger.error(
                ErrorContext(
                    step="get_raw_directions_response",
                    action="exception",
                    error=ErrorDetail(
                        type=type(e).__name__, message=str(e), traceback=""
                    ),
                )
            )
            return None

    async def _make_request(
        self,
        method: str,
        url: str,
        context: str,
        data: Optional[Dict[str, Any]] = None,
        json_data: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
        retry_count: int = 0,
    ) -> Optional[requests.Response]:
        """Make an HTTP request with retry logic and rate limiting.

        Args:
            method: HTTP method (GET, POST, etc.)
            url: Request URL
            context: Context for logging
            data: Form data for POST requests
            json_data: JSON data for POST requests
            headers: Additional headers
            retry_count: Current retry attempt

        Returns:
            Response object if successful, None otherwise
        """
        try:
            # Apply rate limiting
            await self._apply_rate_limit()

            # Prepare request
            request_headers = self.session.headers.copy()
            if headers:
                request_headers.update(headers)

            # Handle CORS preflight for cross-origin POST requests
            if method.upper() == "POST" and "lmdb.skuvault.com" in url:
                preflight_success = await self._handle_cors_preflight(
                    url, request_headers
                )
                if not preflight_success:
                    self.logger.warning(
                        LogContext(
                            step="cors_preflight",
                            action="preflight_failed",
                            details=ServiceDetails(
                                status="failed"
                            ),
                        )
                    )

            # Log request
            self.logger.info(
                LogContext(
                    step="http_request",
                    action=context,
                    details=ServiceDetails(
                        status="requesting"
                    ),
                )
            )

            # Make request
            if method.upper() == "GET":
                response = self.session.get(
                    url,
                    headers=request_headers,
                    timeout=self.settings.skuvault.scraping.web.request_timeout,
                )
            elif method.upper() == "POST":
                if json_data:
                    response = self.session.post(
                        url,
                        json=json_data,
                        headers=request_headers,
                        timeout=self.settings.skuvault.scraping.web.request_timeout,
                    )
                else:
                    response = self.session.post(
                        url,
                        data=data,
                        headers=request_headers,
                        timeout=self.settings.skuvault.scraping.web.request_timeout,
                    )
            else:
                raise ValueError(f"Unsupported HTTP method: {method}")

            # Log response
            self.logger.info(
                LogContext(
                    step="http_request",
                    action=f"{context}_response",
                    details=ServiceDetails(
                        status="received"
                    ),
                )
            )

            # Check for errors
            if response.status_code >= 400:
                return await self._handle_retry(
                    method,
                    url,
                    context,
                    data,
                    json_data,
                    headers,
                    retry_count,
                    response,
                )

            return response

        except Exception as e:
            return await self._handle_retry(
                method, url, context, data, json_data, headers, retry_count, None, e
            )

    async def _apply_rate_limit(self):
        """Apply rate limiting based on configuration."""
        delay = self.settings.skuvault.scraping.rate_limit.request_delay
        if delay > 0:
            await asyncio.sleep(delay)

    async def _handle_cors_preflight(self, url: str, headers: Dict[str, str]) -> bool:
        """Handle CORS preflight request for cross-origin API calls with caching.

        Args:
            url: The target URL for the preflight request
            headers: Headers that will be used in the actual request

        Returns:
            True if preflight succeeds, False otherwise
        """
        try:
            # Check if we have a valid cached preflight response
            cache_key = f"{url}:{hash(frozenset(headers.items()))}"
            current_time = time.time()

            if cache_key in self.cors_preflight_cache:
                cached_result = self.cors_preflight_cache[cache_key]
                if current_time - cached_result["timestamp"] < self.cors_preflight_ttl:
                    self.logger.info(
                        LogContext(
                            step="cors_preflight",
                            action="using_cached_preflight",
                            details={
                                "url": url,
                                "cache_age_seconds": int(current_time - cached_result["timestamp"]),
                                "ttl_remaining_seconds": int(self.cors_preflight_ttl - (current_time - cached_result["timestamp"])),
                            },
                        )
                    )
                    return cached_result["success"]
                else:
                    # Remove expired cache entry
                    del self.cors_preflight_cache[cache_key]

            # Prepare preflight headers based on the actual request headers
            preflight_headers = {
                "Accept": "*/*",
                "Accept-Language": "en-US,en;q=0.9",
                "Accept-Encoding": "gzip, deflate, br, zstd",
                "Connection": "keep-alive",
                "Host": "lmdb.skuvault.com",
                "Origin": "https://v2.skuvault.com",
                "Referer": "https://v2.skuvault.com/",
                "Sec-Fetch-Dest": "empty",
                "Sec-Fetch-Mode": "cors",
                "Sec-Fetch-Site": "same-site",
                "User-Agent": self.settings.skuvault.scraping.web.user_agent,
            }

            # Add access-control-request headers
            if "Authorization" in headers:
                preflight_headers["Access-Control-Request-Headers"] = (
                    "authorization,content-type,dataread"
                )
            else:
                preflight_headers["Access-Control-Request-Headers"] = (
                    "content-type,dataread"
                )

            preflight_headers["Access-Control-Request-Method"] = "POST"

            self.logger.info(
                LogContext(
                    step="cors_preflight",
                    action="sending_preflight",
                    details={
                        "url": url,
                        "headers": preflight_headers,
                        "cache_status": "miss",
                    },
                )
            )

            # Send OPTIONS preflight request
            preflight_response = self.session.options(
                url,
                headers=preflight_headers,
                timeout=self.settings.skuvault.scraping.web.request_timeout,
            )

            self.logger.info(
                LogContext(
                    step="cors_preflight",
                    action="preflight_response",
                    details=ServiceDetails(
                        status="received"
                    ),
                )
            )

            # Check if preflight was successful
            success = preflight_response.status_code == 200

            # Cache the result
            self.cors_preflight_cache[cache_key] = {
                "success": success,
                "timestamp": current_time,
            }

            # Clean up old cache entries to prevent memory leaks
            self._cleanup_cors_preflight_cache()

            if success:
                self.logger.info(
                    LogContext(
                        step="cors_preflight",
                        action="preflight_success_cached",
                        details={
                            "url": url,
                            "cache_key": cache_key,
                            "cache_size": len(self.cors_preflight_cache),
                        },
                    )
                )
                return True
            else:
                self.logger.warning(
                    LogContext(
                        step="cors_preflight",
                        action="preflight_failed",
                        details={
                            "status_code": preflight_response.status_code,
                            "response_text": preflight_response.text[:200],
                            "cache_key": cache_key,
                        },
                    )
                )
                return False

        except Exception as e:
            self.logger.error(
                ErrorContext(
                    error=ErrorDetail(
                        type=type(e).__name__, message=str(e), traceback=""
                    ),
                    details=ErrorDetails(
                        step="cors_preflight",
                        action="preflight_exception",
                        error_type="preflight_error"
                    ),
                )
            )
            return False

    def _cleanup_cors_preflight_cache(self) -> None:
        """Clean up expired CORS preflight cache entries to prevent memory leaks."""
        try:
            current_time = time.time()
            expired_keys = []

            for cache_key, cache_data in self.cors_preflight_cache.items():
                if current_time - cache_data["timestamp"] >= self.cors_preflight_ttl:
                    expired_keys.append(cache_key)

            # Remove expired entries
            for key in expired_keys:
                del self.cors_preflight_cache[key]

            if expired_keys:
                self.logger.info(
                    LogContext(
                        step="cors_preflight",
                        action="cache_cleanup",
                        details={
                            "expired_entries": len(expired_keys),
                            "remaining_entries": len(self.cors_preflight_cache),
                            "cache_size": len(self.cors_preflight_cache),
                        },
                    )
                )

        except Exception as e:
            self.logger.warning(
                LogContext(
                    step="cors_preflight",
                    action="cache_cleanup_failed",
                    details={
                        "error": str(e),
                        "cache_size": len(self.cors_preflight_cache),
                    },
                )
            )

    async def _handle_retry(
        self,
        method: str,
        url: str,
        context: str,
        data: Optional[Dict[str, Any]],
        json_data: Optional[Dict[str, Any]],
        headers: Optional[Dict[str, str]],
        retry_count: int,
        response: Optional[requests.Response] = None,
        exception: Optional[Exception] = None,
    ) -> Optional[requests.Response]:
        """Handle retry logic for failed requests."""
        max_retries = self.settings.skuvault.scraping.error.max_retries

        if retry_count < max_retries:
            retry_delay = self.settings.skuvault.scraping.error.retry_delay * (
                2**retry_count
            )

            self.logger.warning(
                LogContext(
                    step="retry",
                    action="retrying_request",
                    details=ServiceDetails(
                        status="retrying"
                    ),
                )
            )

            await asyncio.sleep(retry_delay)
            return await self._make_request(
                method, url, context, data, json_data, headers, retry_count + 1
            )

        # Max retries exceeded
        error_msg = f"Max retries exceeded for {context}"
        if response:
            error_msg += f" (Status: {response.status_code})"
        if exception:
            error_msg += f" (Error: {exception})"

        self.logger.error(
            ErrorContext(
                error=ErrorDetail(
                    type="MaxRetriesExceeded", message=error_msg, traceback=""
                ),
                details=ErrorDetails(
                    step="retry",
                    action="max_retries_exceeded",
                    error_type="max_retries_error"
                ),
            )
        )

        return None

    def _is_login_successful(self, response: requests.Response) -> bool:
        """Check if login was successful based on response."""
        # Check for redirect to dashboard or main page
        if response.status_code in [200, 302]:
            if "dashboard" in response.url.lower() or "main" in response.url.lower():
                return True

        # Fallback: check for specific HTML elements that indicate successful login
        try:
            soup = BeautifulSoup(response.text, "lxml")
            # Look for elements that indicate successful login
            # This might need adjustment based on actual page structure
            if soup.find("div", {"id": "mount-point"}):
                return True
        except:
            pass

        return False

    def logout(self):
        """Logout and clear session."""
        try:
            # Clear cookies and session data
            self.session.cookies.clear()
            self.is_authenticated = False
            self.auth_token = None

            # Invalidate cached token
            asyncio.create_task(self._invalidate_cached_token())

            self.logger.info(
                LogContext(
                    step="logout",
                    action="clear_session",
                    details=ServiceDetails(
                        status="success"
                    ),
                )
            )
        except Exception as e:
            self.logger.error(
                ErrorContext(
                    error=ErrorDetail(
                        type=type(e).__name__, message=str(e), traceback=""
                    ),
                    details=ErrorDetails(
                        step="logout",
                        action="logout_error",
                        error_type="logout_error"
                    ),
                )
            )

    async def _invalidate_cached_token(self):
        """Invalidate the cached authentication token."""
        try:
            await self.token_cache.invalidate_token("skuvault_web")

            self.logger.info(
                LogContext(
                    step="token_cache",
                    action="token_invalidated",
                    details=ServiceDetails(
                        status="success"
                    ),
                )
            )

        except Exception as e:
            self.logger.error(
                ErrorContext(
                    error=ErrorDetail(
                        type=type(e).__name__,
                        message=f"Failed to invalidate cached token: {e}",
                        traceback="",
                    ),
                    details=ErrorDetails(
                        step="token_cache",
                        action="invalidation_exception",
                        error_type="token_invalidation_error"
                    ),
                )
            )

    async def check_cached_token(self) -> bool:
        """Check if there's a valid cached token and use it if available.

        Returns:
            True if cached token was found and used, False otherwise
        """
        try:
            # Try to get cached token
            cached_token = await self.token_cache.get_token("skuvault_web")

            if cached_token and not cached_token.is_expired:
                # Use cached token
                self.auth_token = cached_token.token
                self.is_authenticated = True
                self._set_api_headers()

                self.logger.info(
                    LogContext(
                        step="token_cache",
                        action="cached_token_used",
                        details=ServiceDetails(
                            status="success"
                        ),
                    )
                )

                return True
            else:
                self.logger.info(
                    LogContext(
                        step="token_cache",
                        action="no_valid_cached_token",
                        details=ServiceDetails(
                            status="no_token"
                        ),
                    )
                )

                return False

        except Exception as e:
            self.logger.error(
                ErrorContext(
                    error=ErrorDetail(
                        type=type(e).__name__,
                        message=f"Failed to check cached token: {e}",
                        traceback="",
                    ),
                    details=ErrorDetails(
                        step="token_cache",
                        action="cache_check_exception",
                        error_type="cache_check_error"
                    ),
                )
            )
            return False

    def get_directions_cache_stats(self) -> Dict[str, Any]:
        """Get statistics about the directions cache.

        Returns:
            Dictionary containing cache statistics for monitoring
        """
        return self.directions_cache.get_stats()

    def invalidate_directions_cache(self, picklist_id: Optional[str] = None) -> None:
        """Invalidate directions cache entries.

        Args:
            picklist_id: Specific picklist ID to invalidate, or None to clear all
        """
        if picklist_id:
            self.directions_cache.invalidate(picklist_id)
            self.logger.info(
                LogContext(
                    step="cache_management",
                    action="invalidated_specific",
                    details={"picklist_id": picklist_id},
                )
            )
        else:
            self.directions_cache.clear()
            self.logger.info(
                LogContext(
                    step="cache_management",
                    action="cleared_all",
                    details={"message": "All directions cache entries cleared"},
                )
            )

    def set_directions_cache_ttl(self, ttl_seconds: int) -> None:
        """Set the time-to-live for directions cache entries.

        Args:
            ttl_seconds: New TTL value in seconds
        """
        # Note: This would require modifying the DirectionsCache class
        # to support dynamic TTL changes. For now, we'll log the request.
        self.logger.info(
            LogContext(
                step="cache_management",
                action="ttl_change_requested",
                details={
                    "requested_ttl": ttl_seconds,
                    "message": "TTL change requires cache reinitialization",
                },
            )
        )

    async def get_latest_session_order_state(
        self, session_order: SessionOrder
    ) -> Optional[SessionOrder]:
        """Get the latest state of a SessionOrder from SkuVault.

        This method follows the same pattern as the session sync service:
        1. Uses sale_id to get latest session data
        2. Gets latest directions for timing and item details
        3. Transforms data using the same SessionOrder creation pattern
        4. Returns updated SessionOrder with latest information

        Args:
            session_order: The SessionOrder to get latest state for

        Returns:
            Updated SessionOrder with latest data, or None if not found

        Example:
            ```python
            from jerky_data_hub.models.skuvault.sessions import SessionOrder

            # Get existing session order from Firestore
            existing_order = SessionOrder(session_id=12345, sale_id="SALE123")

            # Get latest state from SkuVault
            latest_order = await web_service.get_latest_session_order_state(existing_order)
            if latest_order:
                print(f"Updated status: {latest_order.session_status}")
            ```
        """
        if not self.is_authenticated:
            self.logger.error(
                ErrorContext(
                    step="get_latest_session_order_state",
                    action="not_authenticated",
                    error=ErrorDetail(
                        type="AuthenticationError",
                        message="Service not authenticated",
                        traceback="",
                    ),
                )
            )
            return None

        if not session_order.sale_id:
            self.logger.warning(
                LogContext(
                    step="get_latest_session_order_state",
                    action="no_sale_id",
                    details={
                        "session_id": session_order.session_id,
                        "reason": "sale_id_required_for_lookup",
                    },
                )
            )
            return None

        try:
            self.logger.info(
                LogContext(
                    step="get_latest_session_order_state",
                    action="starting_lookup",
                    details={
                        "session_id": session_order.session_id,
                        "sale_id": session_order.sale_id,
                        "picklist_id": session_order.session_picklist_id,
                    },
                )
            )

            # Step 1: Get latest sessions for this sale_id
            sessions = await self.get_sessions_by_sale_id(session_order.sale_id)
            if not sessions:
                self.logger.warning(
                    LogContext(
                        step="get_latest_session_order_state",
                        action="no_sessions_found",
                        details={
                            "sale_id": session_order.sale_id,
                            "reason": "no_sessions_found_for_sale_id",
                        },
                    )
                )
                return None

            # Step 2: Find the session that matches our session_id
            matching_session = None
            for session in sessions:
                if session.session_id == session_order.session_id:
                    matching_session = session
                    break

            if not matching_session:
                self.logger.warning(
                    LogContext(
                        step="get_latest_session_order_state",
                        action="session_not_found",
                        details={
                            "session_id": session_order.session_id,
                            "sale_id": session_order.sale_id,
                            "available_sessions": [s.session_id for s in sessions],
                            "reason": "session_id_not_found_in_latest_data",
                        },
                    )
                )
                return None

            self.logger.info(
                LogContext(
                    step="get_latest_session_order_state",
                    action="session_found",
                    details={
                        "session_id": matching_session.session_id,
                        "picklist_id": matching_session.picklist_id,
                        "status": matching_session.status.value if matching_session.status else None,
                    },
                )
            )

            # Step 3: Get latest session orders using the same pattern as session sync service
            if not matching_session.picklist_id:
                self.logger.warning(
                    LogContext(
                        step="get_latest_session_order_state",
                        action="no_picklist_id",
                        details={
                            "session_id": matching_session.session_id,
                            "reason": "no_picklist_id_for_directions",
                        },
                    )
                )
                return None

            # Use the same method as session sync service to get orders
            latest_orders = await self.get_session_orders(matching_session)
            if not latest_orders:
                self.logger.warning(
                    LogContext(
                        step="get_latest_session_order_state",
                        action="no_orders_found",
                        details={
                            "session_id": matching_session.session_id,
                            "picklist_id": matching_session.picklist_id,
                            "reason": "no_orders_found_for_session",
                        },
                    )
                )
                return None

            # Step 4: Find the specific order that matches our spot_number
            matching_order = None
            for order in latest_orders:
                if order.spot_number == session_order.spot_number:
                    matching_order = order
                    break

            if not matching_order:
                self.logger.warning(
                    LogContext(
                        step="get_latest_session_order_state",
                        action="order_not_found",
                        details={
                            "session_id": matching_session.session_id,
                            "spot_number": session_order.spot_number,
                            "available_spot_numbers": [o.spot_number for o in latest_orders],
                            "reason": "spot_number_not_found_in_latest_orders",
                        },
                    )
                )
                return None

            # Step 5: Create updated SessionOrder using the same pattern as session sync service

            # Parse sale_id to extract order_number and shipment_id using marketplace parser
            # This follows the exact same pattern as _persist_session_orders_batch
            from jerky_data_hub.services.marketplace_id_parser import MarketplaceIdParser

            marketplace_parser = MarketplaceIdParser()
            parsed_components = marketplace_parser.parse_sale_id(matching_order.sale_id or "")

            # Create updated SessionOrder with latest data
            updated_session_order = SessionOrder(
                session_id=matching_session.session_id,
                session_picklist_id=matching_session.picklist_id,
                sale_id=matching_order.sale_id,
                spot_number=matching_order.spot_number,
                order_number=parsed_components.order_number if parsed_components.success else session_order.order_number,
                shipment_id=parsed_components.shipment_id,
                create_date=datetime.fromisoformat(matching_session.created_date.replace('Z', '+00:00')) if matching_session.created_date else None,
                pick_start_datetime=matching_order.pick_start_datetime,
                pick_end_datetime=matching_order.pick_end_datetime,
                order_items=matching_order.order_items,
                picked_by_user_id=matching_order.picked_by_user_id,
                picked_by_user_name=matching_order.picked_by_user_name,
                session_status=matching_session.status,
                # Preserve existing fields that aren't updated from SkuVault
                document_id=session_order.document_id,
                saved_custom_field_2=session_order.saved_custom_field_2,
            )

            # If we have a shipment_id from parsing, use it; otherwise preserve existing
            if parsed_components.shipment_id:
                updated_session_order.shipment_id = parsed_components.shipment_id
            else:
                updated_session_order.shipment_id = session_order.shipment_id

            self.logger.info(
                LogContext(
                    step="get_latest_session_order_state",
                    action="session_order_updated",
                    details={
                        "session_id": updated_session_order.session_id,
                        "sale_id": updated_session_order.sale_id,
                        "spot_number": updated_session_order.spot_number,
                        "order_number": updated_session_order.order_number,
                        "session_status": updated_session_order.session_status.value if updated_session_order.session_status else None,
                        "order_items_count": len(updated_session_order.order_items),
                        "picked_by_user": updated_session_order.picked_by_user_name,
                    },
                )
            )

            return updated_session_order

        except Exception as e:
            self.logger.error(
                ErrorContext(
                    error=ErrorDetail(
                        type=type(e).__name__,
                        message=f"Failed to get latest session order state: {e}",
                        traceback="",
                    ),
                    details=ErrorDetails(
                        step="get_latest_session_order_state",
                        action="lookup_failed",
                        error_type="lookup_error",
                    ),
                )
            )
            return None
